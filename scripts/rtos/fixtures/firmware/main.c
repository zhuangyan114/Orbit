/* Orbit 阶段 0 独立测试固件：只编译，不由构建脚本连接或烧录。 */
#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"
#include "semphr.h"
#include "timers.h"
_Static_assert(sizeof(void *) == 4 && sizeof(uint32_t) == 4, "Cortex-M 32-bit ABI required");
/* 直接从 ELF 导出检查，防止只相信构建脚本声称使用了某组宏。 */
__attribute__((used, section(".fixture_config")))
const uint32_t fixtureConfiguration[] = {
  1, FIXTURE_API, FIXTURE_STATS, FIXTURE_STACK_BOUND, FIXTURE_TICKLESS, FIXTURE_MODE, sizeof(void *)
};
#if FIXTURE_API == 1
#include "cmsis_os.h"
#elif FIXTURE_API == 2
#include "cmsis_os2.h"
#endif
#if FIXTURE_MODE
#include "SEGGER_SYSVIEW.h"
#include "SEGGER_RTT.h"
_Static_assert(sizeof(SEGGER_RTT_BUFFER_UP) == 24, "Target RTT descriptor ABI required");
extern const SEGGER_SYSVIEW_OS_API SYSVIEW_X_OS_TraceAPI;
#endif

typedef struct {
  uint32_t magic, phase, assertLine, created, deleted, timerCalls;
  uint32_t outerActive, nestedIsrCalls, oracleCount, oracleTotal;
} FixtureState;
typedef struct {
  uint32_t mode, frozen, generation, size, wrOff, rdOff, enabledBeforeStop;
  const void *buffer;
} FixtureCapture;
volatile FixtureState fixtureState = { .magic = 0x52544f53 };
volatile FixtureCapture fixtureCapture = { .mode = FIXTURE_MODE };
TaskStatus_t fixtureTaskOracle[20];
TaskHandle_t fixtureTasks[12];
QueueHandle_t fixtureQueue;
SemaphoreHandle_t fixtureMutex, fixtureRecursive, fixtureBinary, fixtureCounting;
TimerHandle_t fixtureTimer;
static StaticTask_t idleTcb, timerTcb;
static StackType_t idleStack[128], timerStack[256];
#if FIXTURE_API == 0
static StaticTask_t workerTcb;
static StackType_t workerStack[256];
#endif
static const char *const names[] = {
  "worker00", "worker01", "worker02", "worker03", "worker04",
  "worker05", "worker06", "worker07", "worker08", "worker09"
};
volatile uint32_t fixtureChecksum;
uint32_t FixtureAmbiguousA(void);
uint32_t FixtureAmbiguousB(void);

void FixtureAssert(unsigned line) {
  fixtureState.assertLine = line;
  __disable_irq();
  for (;;) __NOP();
}
void vApplicationMallocFailedHook(void) { FixtureAssert(__LINE__); }
void vApplicationStackOverflowHook(TaskHandle_t task, char *name) {
  (void)task; (void)name; FixtureAssert(__LINE__);
}
void vApplicationGetIdleTaskMemory(StaticTask_t **tcb, StackType_t **stack, uint32_t *depth) {
  *tcb = &idleTcb; *stack = idleStack; *depth = 128;
}
void vApplicationGetTimerTaskMemory(StaticTask_t **tcb, StackType_t **stack, uint32_t *depth) {
  *tcb = &timerTcb; *stack = timerStack; *depth = 256;
}
void FixtureConfigureRuntime(void) {
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}
uint32_t FixtureRuntime(void) { return DWT->CYCCNT; }
uint32_t FixtureTimestamp(void) { return DWT->CYCCNT; }
uint32_t FixtureInterruptId(void) { return __get_IPSR(); }

static void Worker(void *argument) {
  /* 保留已知大小的真实栈访问，水位仍应由内核填充值判定。 */
  volatile uint8_t scratch[96];
  uint32_t index;
  for (;;) {
    if ((uintptr_t)argument == 2) {
      configASSERT(xSemaphoreTake(fixtureMutex, portMAX_DELAY) == pdTRUE);
      configASSERT(xSemaphoreGive(fixtureMutex) == pdTRUE);
    } else if ((uintptr_t)argument == 3) {
      uint32_t message;
      (void)xQueueReceive(fixtureQueue, &message, portMAX_DELAY);
    }
    for (index = 0; index < sizeof(scratch); ++index) scratch[index] = (uint8_t)index;
    fixtureChecksum += scratch[(uintptr_t)argument % sizeof(scratch)];
    vTaskDelay(10);
  }
}
#if FIXTURE_API == 1
static void WrappedWorker(void const *argument) { Worker((void *)argument); }
osThreadDef(wrapperTask, WrappedWorker, osPriorityNormal, 1, 1024);
#endif
static void TimerCallback(TimerHandle_t timer) {
  (void)timer;
  ++fixtureState.timerCalls;
  (void)xSemaphoreGive(fixtureBinary);
}

/* 软件置 pending 的两个真实 IRQ：EXTI1 优先级更高，可抢占 EXTI0。 */
void EXTI1_IRQHandler(void) {
#if FIXTURE_MODE
  SEGGER_SYSVIEW_RecordEnterISR();
#endif
  if (fixtureState.outerActive) ++fixtureState.nestedIsrCalls;
#if FIXTURE_MODE
  SEGGER_SYSVIEW_RecordExitISR();
#endif
}
void EXTI0_IRQHandler(void) {
#if FIXTURE_MODE
  SEGGER_SYSVIEW_RecordEnterISR();
#endif
  fixtureState.outerActive = 1;
  NVIC_SetPendingIRQ(EXTI1_IRQn);
  __DSB(); __ISB();
  fixtureState.outerActive = 0;
#if FIXTURE_MODE
  SEGGER_SYSVIEW_RecordExitISR();
#endif
}
static void SaveOracle(uint32_t phase) {
  fixtureState.oracleCount = uxTaskGetSystemState(
    fixtureTaskOracle, 20, (uint32_t *)&fixtureState.oracleTotal);
  fixtureState.phase = phase;
}
#if FIXTURE_MODE
static void SendDescription(void) {
  SEGGER_SYSVIEW_SendSysDesc("N=Orbit stage0,D=STM32H723VG,O=FreeRTOS");
}
static void FreezeCapture(void) {
  uint32_t mask = __get_PRIMASK();
  __disable_irq();
  fixtureCapture.enabledBeforeStop = SEGGER_SYSVIEW_IsStarted();
  SEGGER_SYSVIEW_Stop();
  fixtureCapture.buffer = _SEGGER_RTT.aUp[2].pBuffer;
  fixtureCapture.size = _SEGGER_RTT.aUp[2].SizeOfBuffer;
  fixtureCapture.wrOff = _SEGGER_RTT.aUp[2].WrOff;
  fixtureCapture.rdOff = _SEGGER_RTT.aUp[2].RdOff;
  ++fixtureCapture.generation;
  __DMB();
  fixtureCapture.frozen = 1;
  __set_PRIMASK(mask);
}
#endif
static void Coordinator(void *argument) {
  (void)argument;
  configASSERT(xSemaphoreTake(fixtureMutex, portMAX_DELAY) == pdTRUE);
  configASSERT(xSemaphoreTakeRecursive(fixtureRecursive, portMAX_DELAY) == pdTRUE);
  configASSERT(xSemaphoreTakeRecursive(fixtureRecursive, portMAX_DELAY) == pdTRUE);
#if FIXTURE_MODE
  SEGGER_SYSVIEW_Start();
  SEGGER_SYSVIEW_MarkStart(42);
#endif
  vTaskDelay(20);
  SaveOracle(1); /* 初始任务及对象均存在。 */
  configASSERT(xSemaphoreGive(fixtureMutex) == pdTRUE);
  configASSERT(xSemaphoreGiveRecursive(fixtureRecursive) == pdTRUE);
  configASSERT(xSemaphoreGiveRecursive(fixtureRecursive) == pdTRUE);
  vTaskSuspend(fixtureTasks[0]);
  vTaskDelete(fixtureTasks[1]);
  ++fixtureState.deleted;
  NVIC_SetPendingIRQ(EXTI0_IRQn);
  SaveOracle(2); /* suspended 与等待 idle 回收的 termination 场景。 */
  vTaskDelay(20);
  configASSERT(xTaskCreate(Worker, "recreated", 256, (void *)7, 1, &fixtureTasks[1]) == pdPASS);
  ++fixtureState.created;
  vTaskResume(fixtureTasks[0]);
  SaveOracle(3); /* 地址是否复用需实读，不能按名字推断。 */
#if FIXTURE_MODE == 3
  for (uint32_t index = 0; index < 6000; ++index) SEGGER_SYSVIEW_Mark(index);
#endif
#if FIXTURE_MODE
  SEGGER_SYSVIEW_MarkStop(42);
  #if FIXTURE_MODE != 1
  FreezeCapture();
  #endif
#endif
  for (;;) {
#if FIXTURE_MODE == 1
    /* Continuous 持续运行，由标准 Down Stop 命令停止，而非定时自行停止。 */
    if (!SEGGER_SYSVIEW_IsStarted() && !fixtureCapture.frozen) FreezeCapture();
    if (SEGGER_SYSVIEW_IsStarted()) fixtureCapture.frozen = 0;
#endif
    uint32_t value = fixtureState.timerCalls;
    (void)xQueueSend(fixtureQueue, &value, 0);
    vTaskDelay(100);
  }
}
int main(void) {
  SystemCoreClockUpdate();
  /* D-cache 保持关闭，使后续探针 RAM 读取不依赖 cache clean。 */
  FixtureConfigureRuntime();
  fixtureChecksum = FixtureAmbiguousA() + FixtureAmbiguousB();
#if FIXTURE_MODE
  #if FIXTURE_MODE == 3
  static char reservedBuffer[16];
  configASSERT(SEGGER_RTT_ConfigUpBuffer(1, "FixtureReserved", reservedBuffer, sizeof(reservedBuffer), 0) == 0);
  #endif
  SEGGER_SYSVIEW_Init(SystemCoreClock, SystemCoreClock, &SYSVIEW_X_OS_TraceAPI, SendDescription);
  SEGGER_SYSVIEW_SetRAMBase(0x20000000);
#endif
  NVIC_SetPriority(EXTI0_IRQn, 7);
  NVIC_SetPriority(EXTI1_IRQn, 6);
  NVIC_EnableIRQ(EXTI0_IRQn);
  NVIC_EnableIRQ(EXTI1_IRQn);
#if FIXTURE_API == 2
  configASSERT(osKernelInitialize() == 0);
#endif
  fixtureQueue = xQueueCreate(4, sizeof(uint32_t));
  fixtureMutex = xSemaphoreCreateMutex();
  fixtureRecursive = xSemaphoreCreateRecursiveMutex();
  fixtureBinary = xSemaphoreCreateBinary();
  fixtureCounting = xSemaphoreCreateCounting(4, 2);
  configASSERT(fixtureQueue && fixtureMutex && fixtureRecursive && fixtureBinary && fixtureCounting);
  vQueueAddToRegistry(fixtureQueue, "fixture.queue");
  vQueueAddToRegistry(fixtureMutex, "fixture.mutex");
  vQueueAddToRegistry(fixtureRecursive, "fixture.recursive");
  vQueueAddToRegistry(fixtureBinary, "fixture.binary");
  vQueueAddToRegistry(fixtureCounting, "fixture.counting");
  fixtureTimer = xTimerCreate("fixture.timer", 20, pdTRUE, 0, TimerCallback);
  configASSERT(fixtureTimer && xTimerStart(fixtureTimer, 0) == pdPASS);
#if FIXTURE_API == 1
  fixtureTasks[0] = (TaskHandle_t)osThreadCreate(osThread(wrapperTask), 0);
#elif FIXTURE_API == 2
  const osThreadAttr_t attr = { .name = "wrapperTask", .stack_size = 1024, .priority = osPriorityNormal };
  fixtureTasks[0] = (TaskHandle_t)osThreadNew(Worker, 0, &attr);
#else
  fixtureTasks[0] = xTaskCreateStatic(Worker, names[0], 256, 0, 1, workerStack, &workerTcb);
#endif
  configASSERT(fixtureTasks[0]);
  fixtureState.created = 1;
  /* Trace 采用较小任务集，遵守所选官方适配器 8 项任务信息上限。 */
  for (uint32_t index = 1; index < (FIXTURE_MODE ? 2u : 10u); ++index) {
    configASSERT(xTaskCreate(Worker, names[index], 256, (void *)(uintptr_t)index, 1, &fixtureTasks[index]) == pdPASS);
    ++fixtureState.created;
  }
  configASSERT(xTaskCreate(Coordinator, "coordinator", 512, 0, 3, 0) == pdPASS);
#if FIXTURE_API
  (void)osKernelStart();
#else
  vTaskStartScheduler();
#endif
  FixtureAssert(__LINE__);
}
/* 启动文件调用 newlib 构造入口；此 C 工程没有构造函数。 */
void _init(void) {}
void _fini(void) {}

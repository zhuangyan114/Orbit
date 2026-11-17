#ifndef ORBIT_FIXTURE_FREERTOS_CONFIG_H
#define ORBIT_FIXTURE_FREERTOS_CONFIG_H
#include <stdint.h>
#include "stm32h7xx.h"

#ifndef FIXTURE_STATS
#define FIXTURE_STATS 1
#endif
#ifndef FIXTURE_STACK_BOUND
#define FIXTURE_STACK_BOUND 1
#endif
#ifndef FIXTURE_TICKLESS
#define FIXTURE_TICKLESS 0
#endif
#ifndef FIXTURE_API
#define FIXTURE_API 0
#endif
#ifndef FIXTURE_MODE
#define FIXTURE_MODE 0
#endif

/* Cortex-M7 的默认 HSI 时钟；不依赖原应用的 HSE、PLL 或外设初始化。 */
#define configCPU_CLOCK_HZ SystemCoreClock
#define configTICK_RATE_HZ 1000
#define configUSE_PREEMPTION 1
#define configUSE_TIME_SLICING 1
#define configUSE_IDLE_HOOK 0
#define configUSE_TICK_HOOK 0
#define configUSE_16_BIT_TICKS 0
#define configUSE_TICKLESS_IDLE FIXTURE_TICKLESS
#define configMINIMAL_STACK_SIZE 128
#define configTOTAL_HEAP_SIZE (64 * 1024)
#define configMAX_TASK_NAME_LEN 16
#if FIXTURE_API == 2
#define configMAX_PRIORITIES 56
#else
#define configMAX_PRIORITIES 8
#endif
#define configUSE_PORT_OPTIMISED_TASK_SELECTION 0
#define configSUPPORT_DYNAMIC_ALLOCATION 1
#define configSUPPORT_STATIC_ALLOCATION 1
#define configUSE_MUTEXES 1
#define configUSE_RECURSIVE_MUTEXES 1
#define configUSE_COUNTING_SEMAPHORES 1
#define configUSE_TASK_NOTIFICATIONS 1
#define configUSE_TIMERS 1
#define configTIMER_TASK_PRIORITY 2
#define configTIMER_QUEUE_LENGTH 8
#define configTIMER_TASK_STACK_DEPTH 256
#define configQUEUE_REGISTRY_SIZE 12
#define configUSE_TRACE_FACILITY 1
#define configRECORD_STACK_HIGH_ADDRESS FIXTURE_STACK_BOUND
#define configGENERATE_RUN_TIME_STATS FIXTURE_STATS
#define configUSE_STATS_FORMATTING_FUNCTIONS 0
#define configCHECK_FOR_STACK_OVERFLOW 2
#define configUSE_MALLOC_FAILED_HOOK 1
#define configUSE_CO_ROUTINES 0
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY 15
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5
#define configPRIO_BITS 4
#define configKERNEL_INTERRUPT_PRIORITY (15 << 4)
#define configMAX_SYSCALL_INTERRUPT_PRIORITY (5 << 4)
#define INCLUDE_vTaskPrioritySet 1
#define INCLUDE_uxTaskPriorityGet 1
#define INCLUDE_vTaskDelete 1
#define INCLUDE_vTaskSuspend 1
#define INCLUDE_vTaskDelay 1
#define INCLUDE_vTaskDelayUntil 1
#define INCLUDE_xTaskGetSchedulerState 1
#define INCLUDE_xTaskGetCurrentTaskHandle 1
#define INCLUDE_xTaskGetIdleTaskHandle 1
#define INCLUDE_uxTaskGetStackHighWaterMark 1
#define INCLUDE_eTaskGetState 1
#define INCLUDE_xSemaphoreGetMutexHolder 1
#define INCLUDE_xTimerPendFunctionCall 1
void FixtureAssert(unsigned line);
void FixtureConfigureRuntime(void);
uint32_t FixtureRuntime(void);
#define configASSERT(condition) do { if (!(condition)) FixtureAssert(__LINE__); } while (0)
#define portCONFIGURE_TIMER_FOR_RUN_TIME_STATS() FixtureConfigureRuntime()
#define portGET_RUN_TIME_COUNTER_VALUE() FixtureRuntime()
#define vPortSVCHandler SVC_Handler
#define xPortPendSVHandler PendSV_Handler
#if FIXTURE_API != 2
#define xPortSysTickHandler SysTick_Handler
#endif

#if FIXTURE_MODE
#include "SEGGER_SYSVIEW_FreeRTOS.h"
#endif
#endif

/*
 * 独立样本生成器：直接调用固定官方记录器和真实 RTT C 实现。
 * 所有读指针操作仅发生于本进程内存，不访问板卡或连接服务。
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "SEGGER_SYSVIEW.h"
#include "SEGGER_RTT.h"
_Static_assert(sizeof(U32) == 4, "Protocol integer must be 32 bit on the host");

static uint32_t timestamp;
static FILE *raw;
static size_t written;
static size_t produced;
static int overflowCase;
static struct { const char *name; size_t offset, length; } checks[16];
static unsigned checkCount;
uint32_t FixtureTimestamp(void) { return timestamp; }
uint32_t FixtureInterruptId(void) { return 17; }

static unsigned Available(void) {
  SEGGER_RTT_BUFFER_UP *up = &_SEGGER_RTT.aUp[2];
  return (up->WrOff + up->SizeOfBuffer - up->RdOff) % up->SizeOfBuffer;
}
static void Drain(void) {
  SEGGER_RTT_BUFFER_UP *up = &_SEGGER_RTT.aUp[2];
  unsigned count = Available();
  for (unsigned index = 0; index < count; ++index) {
    if (fputc((unsigned char)up->pBuffer[up->RdOff], raw) == EOF) exit(3);
    up->RdOff = (up->RdOff + 1) % up->SizeOfBuffer;
  }
  written += count;
}
static void Packet(const char *name, uint32_t tick, unsigned id, uint32_t value, int noParameter) {
  size_t start = written + Available();
  unsigned before = _SEGGER_RTT.aUp[2].WrOff;
  timestamp = tick;
  if (id == 8) SEGGER_SYSVIEW_OnTaskCreate(value);
  else if (id == 6) SEGGER_SYSVIEW_OnTaskStartReady(value);
  else if (id == 4) SEGGER_SYSVIEW_OnTaskStartExec(value);
  else if (id == 29) SEGGER_SYSVIEW_OnTaskTerminate(value);
  else if (noParameter) SEGGER_SYSVIEW_RecordVoid(id);
  else SEGGER_SYSVIEW_RecordU32(id, value);
  produced += (_SEGGER_RTT.aUp[2].WrOff + 8192 - before) % 8192;
  if (FIXTURE_MODE != 3 && !overflowCase) {
    checks[checkCount].name = name;
    checks[checkCount].offset = start;
    checks[checkCount].length = written + Available() - start;
    ++checkCount;
  }
  if (FIXTURE_MODE == 1 && !overflowCase) Drain();
}
int main(int argc, char **argv) {
  unsigned stateBeforeStop, overflowState = 0, recoveryFirstByte = 0;
  unsigned originalRd, originalWr, used, wrapped = 0;
  size_t discarded = 0;
  int recovered = 0;
  FILE *meta;
  if (argc != 4) return 2;
  overflowCase = strcmp(argv[3], "overflow") == 0;
  raw = fopen(argv[1], "wb");
  meta = fopen(argv[2], "wb");
  if (!raw || !meta) return 3;
  if (FIXTURE_MODE == 3) {
    static char reservedBuffer[16];
    if (SEGGER_RTT_ConfigUpBuffer(1, "FixtureReserved", reservedBuffer, sizeof(reservedBuffer), 0)) return 4;
  }
  SEGGER_SYSVIEW_Init(1000000, 64000000, NULL, NULL);
  if (!_SEGGER_RTT.aUp[2].sName || strcmp(_SEGGER_RTT.aUp[2].sName, "SysView")) return 4;
  SEGGER_SYSVIEW_SetRAMBase(0x20000000);
  timestamp = 100;
  SEGGER_SYSVIEW_Start();
  produced = _SEGGER_RTT.aUp[2].WrOff;
  if (FIXTURE_MODE == 1 && !overflowCase) Drain();
  /* 期望值在 oracle.json 手工维护。连续的 delta 均为 10 ticks。 */
  Packet("task-create", 110, 8, 0x20000100, 0);
  Packet("task-ready", 120, 6, 0x20000100, 0);
  Packet("task-running", 130, 4, 0x20000100, 0);
  Packet("isr-outer", 140, 2, 17, 0);
  Packet("isr-inner", 150, 2, 18, 0);
  Packet("isr-inner-exit", 160, 3, 0, 1);
  Packet("isr-outer-exit", 170, 3, 0, 1);
  Packet("marker-start", 180, 15, 300, 0);
  Packet("marker-stop", 190, 16, 300, 0);
  Packet("task-terminate", 200, 29, 0x20000100, 0);
  if (FIXTURE_MODE == 3 || overflowCase) {
    for (unsigned index = 0; index < 6000; ++index) {
      unsigned before = _SEGGER_RTT.aUp[2].WrOff;
      timestamp += 10;
      SEGGER_SYSVIEW_RecordU32(15, index);
      produced += (_SEGGER_RTT.aUp[2].WrOff + 8192 - before) % 8192;
    }
    wrapped = FIXTURE_MODE == 3 && produced > 8191;
  }
  if (overflowCase) {
    overflowState = SEGGER_SYSVIEW_IsStarted();
  }
  if (overflowCase && FIXTURE_MODE == 1) {
    Drain();
    originalWr = _SEGGER_RTT.aUp[2].WrOff;
    timestamp += 10;
    SEGGER_SYSVIEW_RecordU32(15, 42);
    recoveryFirstByte = (unsigned char)_SEGGER_RTT.aUp[2].pBuffer[originalWr];
    recovered = SEGGER_SYSVIEW_IsStarted() == 1;
    Drain();
  }
  stateBeforeStop = SEGGER_SYSVIEW_IsStarted();
  timestamp += 10;
  originalWr = _SEGGER_RTT.aUp[2].WrOff;
  SEGGER_SYSVIEW_Stop();
  produced += (_SEGGER_RTT.aUp[2].WrOff + 8192 - originalWr) % 8192;
  originalRd = _SEGGER_RTT.aUp[2].RdOff;
  originalWr = _SEGGER_RTT.aUp[2].WrOff;
  used = Available();
  if (FIXTURE_MODE == 3) {
    /* 单线程且已 Stop：此时才读取覆盖缓冲，不提前消费。 */
    discarded = produced - used;
  }
  Drain();
  if (fclose(raw)) return 3;
  fprintf(meta, "{\"mode\":%d,\"case\":\"%s\",\"frozen\":true,"
    "\"timestampBits\":32,\"frequencyHz\":1000000,\"channel\":2,"
    "\"bufferSize\":8192,\"rdOff\":%u,\"wrOff\":%u,\"retainedBytes\":%u,"
    "\"wrapped\":%s,\"discardedPrefixBytes\":%zu,\"integrity\":\"%s\","
    "\"stateBeforeStop\":%u,\"stateAfterStop\":%u,\"overflowState\":%u,"
    "\"recovered\":%s,\"recoveryFirstByte\":%u,\"checks\":[",
    FIXTURE_MODE, argv[3], originalRd, originalWr, used, wrapped ? "true" : "false",
    discarded, wrapped ? "prefix-overwritten" : overflowCase ? "target-overflow" : "complete",
    stateBeforeStop, SEGGER_SYSVIEW_IsStarted(), overflowState,
    recovered ? "true" : "false", recoveryFirstByte);
  for (unsigned index = 0; index < checkCount; ++index) {
    fprintf(meta, "%s{\"name\":\"%s\",\"offset\":%zu,\"length\":%zu}",
      index ? "," : "", checks[index].name, checks[index].offset, checks[index].length);
  }
  fputs("]}\n", meta);
  return fclose(meta) ? 3 : 0;
}

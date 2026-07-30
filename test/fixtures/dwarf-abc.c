#include <stdint.h>

typedef struct {
    uint32_t first;
    uint16_t second;
    uint8_t bytes[3];
} Sample;

volatile uint32_t abc_sink;

__attribute__((noinline)) void C(void)
{
    int c_local = 33;
    int c_array[3] = { 3, 4, 5 };
    Sample c_struct = { 0x11223344u, 0x5566u, { 7, 8, 9 } };
    __asm volatile("nop"); /* Pause here. */
    abc_sink = (uint32_t)c_local + (uint32_t)c_array[1] + c_struct.first;
}

__attribute__((noinline)) void B(void)
{
    int b_local = 22;
    C();
    abc_sink += (uint32_t)b_local;
}

__attribute__((noinline)) void A(void)
{
    int a_local = 11;
    B();
    abc_sink += (uint32_t)a_local;
}

void Reset_Handler(void)
{
    A();
    for (;;) {}
}

#include <stdint.h>
/* 与另一个编译单元同名但布局不同，供阶段 1 类型身份解析使用。 */
struct OrbitSameName { uint8_t tag; uint32_t value; };
volatile struct OrbitSameName fixtureAmbiguousA = { 1, 7 };
uint32_t FixtureAmbiguousA(void) { return fixtureAmbiguousA.value; }

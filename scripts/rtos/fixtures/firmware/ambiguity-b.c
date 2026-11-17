#include <stdint.h>
struct OrbitSameName { uint32_t prefix[3]; uint16_t value; };
volatile struct OrbitSameName fixtureAmbiguousB = { { 1, 2, 3 }, 11 };
uint32_t FixtureAmbiguousB(void) { return fixtureAmbiguousB.value; }

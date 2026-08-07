'use strict';

// Independent ARM FPB oracle. These values intentionally do not import or
// mirror production C++ constants so the mock matrix can catch packing bugs.
const FP_CTRL_ENABLE = 1;
const FP_CTRL_KEY = 2;

function makeFpCtrl({ revision = 1, codeComparators = 6, literalComparators = 2, enabled = false } = {}) {
  if (revision < 1 || revision > 16) throw new RangeError('revision must be in 1..16');
  if (codeComparators < 0 || codeComparators > 0x7f) throw new RangeError('codeComparators must be in 0..127');
  if (literalComparators < 0 || literalComparators > 0x0f) throw new RangeError('literalComparators must be in 0..15');
  return ((((revision - 1) & 0xf) << 28)
    | ((codeComparators & 0x70) << 8)
    | ((literalComparators & 0x0f) << 8)
    | ((codeComparators & 0x0f) << 4)
    | (enabled ? FP_CTRL_ENABLE : 0)) >>> 0;
}

function decodeFpCtrl(value) {
  const control = value >>> 0;
  return {
    revision: 1 + ((control >>> 28) & 0xf),
    codeComparators: ((control >>> 8) & 0x70) | ((control >>> 4) & 0x0f),
    literalComparators: (control >>> 8) & 0x0f,
    enabled: (control & FP_CTRL_ENABLE) !== 0,
  };
}

function normalizeCodeAddress(address) {
  if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) {
    throw new RangeError('address must be a uint32');
  }
  return (address & 0xfffffffe) >>> 0;
}

function encodeComparator(revision, address) {
  const normalized = normalizeCodeAddress(address);
  if (revision === 1) {
    if (normalized >= 0x20000000) throw new RangeError('FPBv1 code address is outside 0x00000000..0x1fffffff');
    const replace = (normalized & 2) === 0 ? 1 : 2;
    return (((normalized & 0x1ffffffc) | (replace << 30) | 1) >>> 0);
  }
  if (revision === 2) return ((normalized & 0xfffffffe) | 1) >>> 0;
  throw new RangeError(`unsupported FPB revision ${revision}`);
}

module.exports = {
  FP_CTRL_ENABLE,
  FP_CTRL_KEY,
  makeFpCtrl,
  decodeFpCtrl,
  normalizeCodeAddress,
  encodeComparator,
};

import { describe, it, expect } from 'vitest';
import { safeEvaluate } from '../src/agent/tools.js';

describe('safeEvaluate', () => {
  // ─── Basic arithmetic ─────────────────────────────────────
  it('should add two numbers', () => {
    expect(safeEvaluate('2 + 3')).toBe(5);
  });

  it('should subtract', () => {
    expect(safeEvaluate('10 - 4')).toBe(6);
  });

  it('should multiply', () => {
    expect(safeEvaluate('3 * 7')).toBe(21);
  });

  it('should divide', () => {
    expect(safeEvaluate('20 / 5')).toBe(4);
  });

  it('should handle modulo', () => {
    expect(safeEvaluate('17 % 5')).toBe(2);
  });

  // ─── Precedence & grouping ────────────────────────────────
  it('should respect operator precedence', () => {
    expect(safeEvaluate('2 + 3 * 4')).toBe(14);
  });

  it('should respect parentheses', () => {
    expect(safeEvaluate('(2 + 3) * 4')).toBe(20);
  });

  it('should handle nested parentheses', () => {
    expect(safeEvaluate('((2 + 3) * (4 - 1))')).toBe(15);
  });

  // ─── Decimals & negation ──────────────────────────────────
  it('should handle decimals', () => {
    expect(safeEvaluate('3.14 * 2')).toBeCloseTo(6.28);
  });

  it('should handle unary minus', () => {
    expect(safeEvaluate('-5 + 3')).toBe(-2);
  });

  it('should handle unary plus', () => {
    expect(safeEvaluate('+5')).toBe(5);
  });

  // ─── Functions ────────────────────────────────────────────
  it('should compute sqrt', () => {
    expect(safeEvaluate('sqrt(16)')).toBe(4);
  });

  it('should compute pow', () => {
    expect(safeEvaluate('pow(2, 8)')).toBe(256);
  });

  it('should compute abs', () => {
    expect(safeEvaluate('abs(-42)')).toBe(42);
  });

  it('should compute round', () => {
    expect(safeEvaluate('round(3.7)')).toBe(4);
  });

  it('should compute ceil and floor', () => {
    expect(safeEvaluate('ceil(3.2)')).toBe(4);
    expect(safeEvaluate('floor(3.8)')).toBe(3);
  });

  it('should compute min and max', () => {
    expect(safeEvaluate('min(3, 7, 1)')).toBe(1);
    expect(safeEvaluate('max(3, 7, 1)')).toBe(7);
  });

  // ─── Complex expressions ─────────────────────────────────
  it('should handle complex expressions', () => {
    expect(safeEvaluate('234 * 567')).toBe(132678);
  });

  it('should handle function in expression', () => {
    expect(safeEvaluate('sqrt(16) + pow(2, 3)')).toBe(12);
  });

  // ─── Error handling ───────────────────────────────────────
  it('should throw on division by zero', () => {
    expect(() => safeEvaluate('1 / 0')).toThrow('not finite');
  });

  it('should throw on invalid characters', () => {
    expect(() => safeEvaluate('2 & 3')).toThrow('Invalid character');
  });

  it('should throw on unknown functions', () => {
    expect(() => safeEvaluate('sin(3.14)')).toThrow('Unknown function');
  });

  it('should throw on malformed expressions', () => {
    expect(() => safeEvaluate('2 + + *')).toThrow();
  });

  it('should throw on empty expression', () => {
    expect(() => safeEvaluate('')).toThrow();
  });
});

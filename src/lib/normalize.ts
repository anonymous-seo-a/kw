import { createHash } from 'node:crypto';

/**
 * Keyword normalization for dedup.
 * - NFKC（全角→半角の互換）
 * - 小文字化
 * - ゼロ幅文字除去
 * - 連続空白を1個に圧縮、前後trim
 */
export function normalizeKeyword(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  return `r_${ts}_${rand}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

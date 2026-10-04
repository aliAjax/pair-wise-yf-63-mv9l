import type { BlindParseResult, BlindRow, RegArm } from '~/types/register';

/** 解析并校验盲底 CSV：分层,区组,编号,组别（首行表头）。有错整份退回，不做局部采纳。 */
export function parseBlindCsv(text: string): BlindParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const issues: { line: number; message: string }[] = [];

  if (lines.length < 2) {
    return { ok: false, rows: [], issues: [{ line: 0, message: '文件为空或只有表头，无法导入' }] };
  }

  const header = lines[0].split(',').map((cell) => cell.trim());
  const expected = ['stratum', 'block', 'sequence', 'arm'];
  const headerOk = expected.every((key) => header.some((cell) => cell.toLowerCase() === key));
  if (!headerOk) {
    issues.push({ line: 1, message: `表头必须为 ${expected.join(',')}，当前为：${header.join(',') || '（空）'}` });
    return { ok: false, rows: [], issues };
  }

  const rows: BlindRow[] = [];
  lines.slice(1).forEach((line, index) => {
    const lineNo = index + 2;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== 4) {
      issues.push({ line: lineNo, message: `应为4列（分层,区组,编号,组别），实际 ${cells.length} 列` });
      return;
    }
    const [stratum, blockText, sequenceText, armText] = cells;
    if (!stratum) issues.push({ line: lineNo, message: '分层为空' });
    const block = Number(blockText);
    const sequence = Number(sequenceText);
    if (!Number.isInteger(block) || block < 1) issues.push({ line: lineNo, message: `区组非法：${blockText}` });
    if (!Number.isInteger(sequence) || sequence < 1) issues.push({ line: lineNo, message: `编号非法：${sequenceText}` });
    const arm = armText.toUpperCase() as RegArm;
    if (arm !== 'A' && arm !== 'B') issues.push({ line: lineNo, message: `组别非法：${armText}（只允许 A/B）` });
    if (stratum && Number.isInteger(block) && Number.isInteger(sequence) && (arm === 'A' || arm === 'B')) {
      rows.push({ stratum, block, sequence, arm });
    }
  });

  if (issues.length > 0) return { ok: false, rows: [], issues };

  // 按分层检查：编号断档/重号、区组顺序、名额配平（跨分层允许同序号）
  const strata = [...new Set(rows.map((row) => row.stratum))];
  for (const stratum of strata) {
    const subset = rows.filter((row) => row.stratum === stratum);

    const bySequence = new Map<number, number>();
    subset.forEach((row) => bySequence.set(row.sequence, (bySequence.get(row.sequence) ?? 0) + 1));
    [...bySequence.entries()].filter(([, count]) => count > 1).forEach(([sequence]) => {
      issues.push({ line: 0, message: `分层「${stratum}」内编号 ${sequence} 重号` });
    });

    const sequences = [...bySequence.keys()].sort((a, b) => a - b);
    if (sequences.length > 0) {
      for (let expected = 1; expected <= sequences[sequences.length - 1]; expected += 1) {
        if (!bySequence.has(expected)) issues.push({ line: 0, message: `分层「${stratum}」编号断档：缺少 ${expected}` });
      }
    }

    // 文件需按 区组、编号 顺序排列（统计组盲底标准导出顺序）
    subset.forEach((row, index) => {
      if (index > 0 && row.block < subset[index - 1].block) {
        issues.push({ line: 0, message: `分层「${stratum}」区组顺序错乱：${subset[index - 1].block} 后出现 ${row.block}` });
      }
      if (index > 0 && row.block === subset[index - 1].block && row.sequence <= subset[index - 1].sequence) {
        issues.push({ line: 0, message: `分层「${stratum}」区组 ${row.block} 内编号未按顺序排列` });
      }
    });

    const blockIds = [...new Set(subset.map((row) => row.block))].sort((a, b) => a - b);
    const expectedBlockIds = Array.from({ length: blockIds.length }, (_, index) => index + 1);
    if (blockIds.some((id, index) => id !== expectedBlockIds[index])) {
      issues.push({ line: 0, message: `分层「${stratum}」区组断档：实际 ${blockIds.join(',')}` });
    }

    for (const blockId of blockIds) {
      const blockRows = subset.filter((row) => row.block === blockId).sort((a, b) => a.sequence - b.sequence);
      const countA = blockRows.filter((row) => row.arm === 'A').length;
      const countB = blockRows.filter((row) => row.arm === 'B').length;
      if (countA !== countB) {
        issues.push({ line: 0, message: `分层「${stratum}」区组 ${blockId} 名额不配平：A=${countA}，B=${countB}` });
      }
      const seqValues = blockRows.map((row) => row.sequence);
      for (let i = 1; i < seqValues.length; i += 1) {
        if (seqValues[i] !== seqValues[i - 1] + 1) {
          issues.push({ line: 0, message: `分层「${stratum}」区组 ${blockId} 内编号不连续` });
        }
      }
    }
  }

  const deduped = [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
  return { ok: deduped.length === 0, rows: deduped.length === 0 ? rows : [], issues: deduped };
}

/** 本中心台账本地组别算法：同分层已占用名额按 A/B 交替配平（用于与盲底对账） */
export function computeLocalArm(active: { localArm: RegArm }[]): RegArm {
  const countA = active.filter((item) => item.localArm === 'A').length;
  const countB = active.filter((item) => item.localArm === 'B').length;
  return countA <= countB ? 'A' : 'B';
}

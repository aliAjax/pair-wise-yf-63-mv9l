import { defineStore } from 'pinia';
import type {
  Arm, AuditEntry, BlindCode, BlindList, Discrepancy, IssueInput,
  IssuedRecord, MergeConflict, AgeBand
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-registry-v1';
export const SITES = ['上海中心', '广州中心', '新加坡中心'];
export const AGE_BANDS: AgeBand[] = ['18-44', '45-64', '65+'];
const BLOCK_SIZE = 4;

const stratumKey = (site: string, ageBand: string) => `${site}|${ageBand}`;

/* ---------------- 种子盲底（统计组下发 v1） ---------------- */

function buildSeedBlind(): BlindList {
  const codes: BlindCode[] = [];
  let s = 0;
  for (const site of SITES) {
    for (const ageBand of AGE_BANDS) {
      const base = 1000 + s * 8;
      for (let b = 1; b <= 2; b++) {
        for (let i = 0; i < BLOCK_SIZE; i++) {
          // 每区组 2A2B：1 区组 A B A B，2 区组 B A B A，分层配平
          const arm: Arm = (i % 2 === 0) ? (b === 1 ? 'A' : 'B') : (b === 1 ? 'B' : 'A');
          codes.push({
            code: base + (b - 1) * BLOCK_SIZE + i + 1,
            stratum: stratumKey(site, ageBand),
            site, ageBand, block: b, arm, status: 'available'
          });
        }
      }
      s++;
    }
  }
  return { version: 1, importedAt: new Date(Date.now() - 86400_000).toISOString(), source: '统计组盲底 v1（种子）', codes };
}

function buildSeedState() {
  const blind = buildSeedBlind();
  const findCode = (site: string, ageBand: string, arm: Arm) =>
    blind.codes.find((c) => c.site === site && c.ageBand === ageBand && c.arm === arm)!;
  const c1 = findCode('上海中心', '45-64', 'A');
  const c2 = findCode('上海中心', '45-64', 'B');
  c1.status = 'issued';
  c2.status = 'issued';
  const ledger: IssuedRecord[] = [
    {
      id: 'r-1', code: c1.code, stratum: c1.stratum, site: c1.site, ageBand: c1.ageBand, block: c1.block,
      arm: 'A', localArm: 'A', participantNo: 'S01-001', identityKey: 'demo-a',
      status: 'enrolled', pendingConfirm: false,
      issuedAt: new Date(Date.now() - 7200_000).toISOString(), enrolledAt: new Date(Date.now() - 7000_000).toISOString(),
      actor: '研究者张宁', offline: false, mergeState: 'merged', localSeq: 1
    },
    {
      id: 'r-2', code: c2.code, stratum: c2.stratum, site: c2.site, ageBand: c2.ageBand, block: c2.block,
      arm: 'B', localArm: 'B', participantNo: 'S01-002', identityKey: 'demo-b',
      status: 'enrolled', pendingConfirm: false,
      issuedAt: new Date(Date.now() - 3600_000).toISOString(), enrolledAt: new Date(Date.now() - 3500_000).toISOString(),
      actor: '研究者张宁', offline: false, mergeState: 'merged', localSeq: 2
    }
  ];
  const discrepancies: Discrepancy[] = [
    {
      id: 'd-1', at: new Date(Date.now() - 1800_000).toISOString(), actor: '研究者张宁',
      participantNo: 'S02-003', stratum: stratumKey('广州中心', '18-44'),
      blindArm: 'B', localArm: 'A',
      detail: '发号拦下：盲底编号 1026 组别为 B，本地计算组别为 A'
    }
  ];
  const audits: AuditEntry[] = [
    { id: 'a-1', at: new Date(Date.now() - 86400_000).toISOString(), actor: '系统', action: 'blind-imported', detail: '统计组盲底 v1 导入，共 72 个编号，校验通过' },
    { id: 'a-2', at: new Date(Date.now() - 3600_000).toISOString(), actor: '研究者张宁', action: 'number-issued', detail: 'S01-002 发号：编号 ' + c2.code + '（区组 1，组别 B），以盲底为准', participantNo: 'S01-002' },
    { id: 'a-3', at: new Date(Date.now() - 1800_000).toISOString(), actor: '研究者张宁', action: 'issue-blocked', detail: 'S02-003 组别不一致已拦下：盲底 B vs 本地 A，差异已留档', participantNo: 'S02-003' }
  ];
  return { blind, ledger, discrepancies, conflicts: [] as MergeConflict[], audits, localSeq: 2 };
}

/* ---------------- 盲底解析与校验 ---------------- */

interface RawCode { code: number; stratum: string; block: number; arm: Arm; }

function parseBlind(raw: string): { raw?: RawCode[]; error?: string } {
  const text = raw.trim();
  if (!text) return { error: '粘贴内容为空' };
  if (text.startsWith('[') || text.startsWith('{')) {
    let arr: unknown;
    try { arr = JSON.parse(text); } catch (e) { return { error: 'JSON 解析失败：' + (e as Error).message }; }
    if (!Array.isArray(arr)) return { error: 'JSON 必须是数组' };
    const out: RawCode[] = [];
    for (const [i, item] of arr.entries()) {
      const row = item as Record<string, unknown>;
      const code = Number(row.code);
      const stratum = String(row.stratum ?? '');
      const block = Number(row.block);
      const arm = String(row.arm ?? '').toUpperCase();
      if (!Number.isInteger(code)) return { error: `第 ${i + 1} 行编号非法` };
      if (!stratum.includes('|')) return { error: `第 ${i + 1} 行分层格式应为 中心|年龄层` };
      if (!Number.isInteger(block) || block < 1) return { error: `第 ${i + 1} 行区组号非法` };
      if (arm !== 'A' && arm !== 'B') return { error: `第 ${i + 1} 行组别非法（应为 A/B）` };
      out.push({ code, stratum, block, arm: arm as Arm });
    }
    return { raw: out };
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: RawCode[] = [];
  let start = 0;
  if (/code|编号/i.test(lines[0])) start = 1;
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(/[,，\t]/).map((p) => p.trim());
    if (parts.length < 4) return { error: `第 ${i + 1} 行列数不足（应为 编号,分层,区组,组别）` };
    const code = Number(parts[0]);
    const stratum = parts[1];
    const block = Number(parts[2]);
    const arm = parts[3].toUpperCase();
    if (!Number.isInteger(code)) return { error: `第 ${i + 1} 行编号非法` };
    if (!stratum.includes('|')) return { error: `第 ${i + 1} 行分层格式应为 中心|年龄层` };
    if (!Number.isInteger(block) || block < 1) return { error: `第 ${i + 1} 行区组号非法` };
    if (arm !== 'A' && arm !== 'B') return { error: `第 ${i + 1} 行组别非法（应为 A/B）` };
    out.push({ code, stratum, block, arm: arm as Arm });
  }
  return { raw: out };
}

/** 按分层和区组检查编号断档、重号、名额配平；有错返回错误清单（整份退回） */
function validateBlind(raw: RawCode[]): string[] {
  const errors: string[] = [];
  if (raw.length === 0) return ['盲底为空'];
  const seen = new Map<number, number>();
  for (const [i, c] of raw.entries()) {
    const prev = seen.get(c.code);
    if (prev !== undefined) errors.push(`重号：编号 ${c.code} 在第 ${prev + 1} 行与第 ${i + 1} 行重复`);
    else seen.set(c.code, i);
  }
  for (const [i, c] of raw.entries()) {
    const [site, ageBand] = c.stratum.split('|');
    if (!SITES.includes(site)) errors.push(`第 ${i + 1} 行中心非法：${site}`);
    if (!AGE_BANDS.includes(ageBand as AgeBand)) errors.push(`第 ${i + 1} 行年龄层非法：${ageBand}`);
  }
  const strata = new Map<string, RawCode[]>();
  for (const c of raw) {
    if (!strata.has(c.stratum)) strata.set(c.stratum, []);
    strata.get(c.stratum)!.push(c);
  }
  for (const [stratum, list] of strata) {
    const codes = list.map((c) => c.code).sort((a, b) => a - b);
    for (let n = codes[0]; n <= codes[codes.length - 1]; n++) {
      if (!codes.includes(n)) errors.push(`分层 ${stratum} 编号断档：缺少 ${n}`);
    }
    const blocks = new Map<number, RawCode[]>();
    for (const c of list) {
      if (!blocks.has(c.block)) blocks.set(c.block, []);
      blocks.get(c.block)!.push(c);
    }
    const sizes = new Set<number>();
    const blockNos = [...blocks.keys()].sort((a, b) => a - b);
    for (let n = 1; n <= blockNos[blockNos.length - 1]; n++) {
      if (!blocks.has(n)) errors.push(`分层 ${stratum} 缺少区组 ${n}`);
    }
    for (const [block, blist] of blocks) {
      const a = blist.filter((c) => c.arm === 'A').length;
      const b = blist.length - a;
      if (a !== b) errors.push(`分层 ${stratum} 区组 ${block} 名额不配平：A=${a} B=${b}`);
      sizes.add(blist.length);
    }
    if (sizes.size > 1) errors.push(`分层 ${stratum} 区组大小不一致：${[...sizes].join('/')}`);
  }
  return errors;
}

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, buildSeedState()),
  getters: {
    blindVersion: (state) => state.blind?.version ?? 0,
    issuedCount: (state) => state.ledger.filter((r) => r.status === 'issued' && !r.pendingConfirm).length,
    enrolledCount: (state) => state.ledger.filter((r) => r.status === 'enrolled' || r.status === 'unblinded').length,
    pendingConfirmCount: (state) => state.ledger.filter((r) => r.status === 'issued' && r.pendingConfirm).length,
    discrepancyCount: (state) => state.discrepancies.length,
    conflictCount: (state) => state.conflicts.length,
    offlinePendingCount: (state) => state.ledger.filter((r) => r.mergeState === 'pending').length
  },
  actions: {
    persist() { writeLocal(STORAGE_KEY, this.$state); },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
    },

    /** 本地按名额配平规则计算组别：A 不多于 B 时取 A，否则取 B */
    computeLocalArm(stratum: string): Arm {
      const inStratum = this.ledger.filter((r) => r.stratum === stratum && r.status !== 'void');
      const a = inStratum.filter((r) => r.localArm === 'A').length;
      const b = inStratum.filter((r) => r.localArm === 'B').length;
      return a <= b ? 'A' : 'B';
    },

    /**
     * 导入统计组盲底：先按分层+区组校验断档/重号/配平，有错整份退回；
     * 通过后更新版本，并把已发号未入组记录作废重排、列入待确认。
     */
    importBlindList(raw: string, source: string, actor: string): { ok: boolean; errors?: string[]; version?: number } {
      const parsed = parseBlind(raw);
      if (parsed.error) {
        this.addAudit('blind-rejected', `盲底导入失败，整份退回：${parsed.error}`, actor);
        this.persist();
        return { ok: false, errors: [parsed.error] };
      }
      const errors = validateBlind(parsed.raw!);
      if (errors.length > 0) {
        this.addAudit('blind-rejected', `盲底校验不通过，整份退回：${errors.join('；')}`, actor);
        this.persist();
        return { ok: false, errors };
      }
      const version = this.blind.version + 1;
      const codes: BlindCode[] = parsed.raw!.map((c) => ({
        ...c,
        site: c.stratum.split('|')[0],
        ageBand: c.stratum.split('|')[1] as AgeBand,
        status: 'available' as const
      }));
      const reissued: IssuedRecord[] = [];
      for (const rec of this.ledger) {
        if (rec.status !== 'issued' || rec.pendingConfirm) continue;
        rec.status = 'void';
        rec.voidReason = `盲底更新至 v${version}，已发号未入组，作废重排`;
        rec.voidedAt = new Date().toISOString();
        this.addAudit('voided', `编号 ${rec.code}（${rec.participantNo}）因盲底更新作废`, actor, rec.participantNo);
        const next = codes
          .filter((c) => c.stratum === rec.stratum && c.status === 'available')
          .sort((a, b) => a.code - b.code)[0];
        if (next) {
          const newRec: IssuedRecord = {
            id: crypto.randomUUID(), code: next.code, stratum: rec.stratum,
            site: rec.site, ageBand: rec.ageBand, block: next.block,
            arm: next.arm, localArm: this.computeLocalArm(rec.stratum),
            participantNo: rec.participantNo, identityKey: rec.identityKey,
            status: 'issued', pendingConfirm: true,
            issuedAt: new Date().toISOString(), actor,
            offline: false, mergeState: 'merged', localSeq: ++this.localSeq
          };
          next.status = 'issued';
          reissued.push(newRec);
          this.addAudit('reissued', `${rec.participantNo} 已作废重排为编号 ${next.code}（盲底 v${version}），待中心确认`, actor, rec.participantNo);
        } else {
          this.addAudit('reissued', `${rec.participantNo} 作废后在新盲底分层 ${rec.stratum} 无可用编号，待人工处理`, actor, rec.participantNo);
        }
      }
      this.ledger.unshift(...reissued);
      this.blind = { version, importedAt: new Date().toISOString(), source: source.trim() || '统计组盲底', codes };
      this.addAudit('blind-updated', `盲底更新至 v${version}，共 ${codes.length} 个编号；作废重排 ${reissued.length} 条，已列入待确认`, actor);
      this.persist();
      return { ok: true, version };
    },

    /**
     * 中心发号：以盲底为准取组别；本地计算组别对不上时拦下并留差异。
     * 断网时先留本中心（不占盲底编号），恢复后按顺序合并。
     */
    issueNumber(input: IssueInput, offline = false): { ok: boolean; message: string; blocked?: boolean; discrepancy?: Discrepancy } {
      if (this.ledger.some((r) => r.status !== 'void' && (r.participantNo === input.participantNo || r.identityKey === input.identityKey))) {
        this.addAudit('duplicate-blocked', `拒绝重复发号：${input.participantNo}（编号或身份标识已存在）`, input.actor, input.participantNo);
        this.persist();
        return { ok: false, message: '受试者编号或身份标识已存在，已阻止重复发号' };
      }
      const stratum = stratumKey(input.site, input.ageBand);
      const localArm = this.computeLocalArm(stratum);
      const next = this.blind.codes
        .filter((c) => c.stratum === stratum && c.status === 'available')
        .sort((a, b) => a.code - b.code)[0];
      if (!next) return { ok: false, message: `分层 ${stratum} 暂无可用编号（名额配满），请联系统计组` };

      if (offline) {
        const rec: IssuedRecord = {
          id: crypto.randomUUID(), code: next.code, stratum, site: input.site, ageBand: input.ageBand, block: next.block,
          arm: next.arm, localArm, participantNo: input.participantNo, identityKey: input.identityKey,
          status: 'issued', pendingConfirm: false, issuedAt: new Date().toISOString(), actor: input.actor,
          offline: true, mergeState: 'pending', localSeq: ++this.localSeq
        };
        this.ledger.unshift(rec);
        this.addAudit('offline-queued', `断网暂存发号 ${input.participantNo}（编号 ${next.code}，本地顺序 ${rec.localSeq}），待恢复后按顺序合并`, input.actor, input.participantNo);
        this.persist();
        return { ok: true, message: '已断网暂存本中心，恢复联网后按顺序合并' };
      }

      if (localArm !== next.arm) {
        const discrepancy: Discrepancy = {
          id: crypto.randomUUID(), at: new Date().toISOString(), actor: input.actor,
          participantNo: input.participantNo, stratum,
          blindArm: next.arm, localArm,
          detail: `发号拦下：盲底编号 ${next.code} 组别为 ${next.arm}，本地计算组别为 ${localArm}`
        };
        this.discrepancies.unshift(discrepancy);
        this.addAudit('issue-blocked', `${discrepancy.detail}，已拦下并留差异`, input.actor, input.participantNo);
        this.persist();
        return { ok: false, message: `组别不一致已拦下：盲底 ${next.arm} vs 本地 ${localArm}，差异已留档，请联系统计组核对`, blocked: true, discrepancy };
      }

      const rec: IssuedRecord = {
        id: crypto.randomUUID(), code: next.code, stratum, site: input.site, ageBand: input.ageBand, block: next.block,
        arm: next.arm, localArm, participantNo: input.participantNo, identityKey: input.identityKey,
        status: 'issued', pendingConfirm: false, issuedAt: new Date().toISOString(), actor: input.actor,
        offline: false, mergeState: 'merged', localSeq: ++this.localSeq
      };
      next.status = 'issued';
      this.ledger.unshift(rec);
      this.addAudit('number-issued', `${input.participantNo} 发号：编号 ${next.code}（区组 ${next.block}，组别 ${next.arm}），以盲底为准`, input.actor, input.participantNo);
      this.persist();
      return { ok: true, message: `发号成功：编号 ${next.code}，组别 ${next.arm}` };
    },

    /** 已发号记录入组 */
    enroll(id: string, actor: string) {
      const rec = this.ledger.find((r) => r.id === id);
      if (!rec || rec.status !== 'issued' || rec.pendingConfirm) return;
      rec.status = 'enrolled';
      rec.enrolledAt = new Date().toISOString();
      this.addAudit('enrolled', `${rec.participantNo} 入组（编号 ${rec.code}，组别 ${rec.arm}）`, actor, rec.participantNo);
      this.persist();
    },

    /** 盲底更新后作废重排的记录，中心核对确认 */
    confirmPending(id: string, actor: string) {
      const rec = this.ledger.find((r) => r.id === id);
      if (!rec || rec.status !== 'issued' || !rec.pendingConfirm) return;
      rec.pendingConfirm = false;
      rec.confirmedAt = new Date().toISOString();
      this.addAudit('pending-confirmed', `${rec.participantNo} 确认重排编号 ${rec.code}，按盲底组别 ${rec.arm} 执行`, actor, rec.participantNo);
      this.persist();
    },

    /** 紧急揭盲：填写原因，仅追加审计 */
    emergencyUnblind(id: string, reason: string, actor: string) {
      const rec = this.ledger.find((r) => r.id === id);
      if (!rec || !reason.trim()) return;
      rec.status = 'unblinded';
      rec.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；编号 ${rec.code} 组别 ${rec.arm}`, actor, rec.participantNo);
      this.persist();
    },

    /**
     * 恢复联网：把断网期间暂存的发号记录按本地顺序合并。
     * 编号仍可用且组别一致 → 合并入库；否则冲突两边都留。
     */
    mergeOffline(actor: string): { merged: number; conflicts: number } {
      const pending = this.ledger
        .filter((r) => r.mergeState === 'pending')
        .sort((a, b) => a.localSeq - b.localSeq);
      let merged = 0;
      let conflicts = 0;
      for (const rec of pending) {
        const codeInBlind = this.blind.codes.find((c) => c.code === rec.code);
        const winner = this.ledger.find((r) => r.mergeState === 'merged' && r.code === rec.code && r.id !== rec.id);
        if (codeInBlind && codeInBlind.status === 'available' && !winner && codeInBlind.arm === rec.arm) {
          codeInBlind.status = 'issued';
          rec.mergeState = 'merged';
          rec.offline = false;
          this.addAudit('offline-merged', `${rec.participantNo}（编号 ${rec.code}）断网记录已按顺序合并入库`, actor, rec.participantNo);
          merged++;
        } else {
          rec.mergeState = 'conflict';
          const serverSide = winner
            ? { participantNo: winner.participantNo, code: winner.code, arm: winner.arm }
            : codeInBlind
              ? { participantNo: undefined, code: codeInBlind.code, arm: codeInBlind.arm }
              : { participantNo: undefined, code: rec.code, arm: rec.arm };
          const conflict: MergeConflict = {
            id: crypto.randomUUID(), at: new Date().toISOString(),
            localSide: { participantNo: rec.participantNo, code: rec.code, arm: rec.arm, localSeq: rec.localSeq },
            serverSide,
            detail: winner
              ? `编号 ${rec.code} 已被 ${winner.participantNo} 占用，本地 ${rec.participantNo} 与服务器两边都留`
              : `编号 ${rec.code} 在盲底更新后不可用（组别或编号已变），本地 ${rec.participantNo} 与服务器两边都留`
          };
          this.conflicts.unshift(conflict);
          this.addAudit('merge-conflict', conflict.detail, actor, rec.participantNo);
          conflicts++;
        }
      }
      this.persist();
      return { merged, conflicts };
    }
  }
});

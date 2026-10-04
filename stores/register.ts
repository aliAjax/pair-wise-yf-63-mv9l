import { defineStore } from 'pinia';
import type {
  BlindRow,
  BlindVersion,
  DispenseRecord,
  Discrepancy,
  PendingReissue,
  RegArm,
  RegisterLog,
  UpdatePreview
} from '~/types/register';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import { computeLocalArm } from '~/composables/useBlindImport';

const STORAGE_KEY = 'blind-register-v1';

interface RegisterState {
  blind: BlindVersion | null;
  records: DispenseRecord[];
  discrepancies: Discrepancy[];
  reissues: PendingReissue[];
  logs: RegisterLog[];
}

const seed: RegisterState = { blind: null, records: [], discrepancies: [], reissues: [], logs: [] };

export interface IssueResult {
  ok: boolean;
  message: string;
  recordId?: string;
  discrepancyId?: string;
  sequence?: number;
  arm?: RegArm;
}

export interface SyncSummary {
  sent: number;
  conflicts: number;
  centralIncoming: number;
}

export const useRegisterStore = defineStore('register', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    strata: (state) => [...new Set((state.blind?.rows ?? []).map((row) => row.stratum))],
    openDiscrepancies: (state) => state.discrepancies.filter((item) => item.status === 'open'),
    pendingReissues: (state) => state.reissues.filter((item) => item.status === 'pending'),
    offlineQueue: (state) => state.records.filter((item) => item.origin === 'local' && item.offline && !item.synced && item.status === 'issued')
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, { blind: this.blind, records: this.records, discrepancies: this.discrepancies, reissues: this.reissues, logs: this.logs });
    },
    log(action: string, detail: string, actor: string) {
      this.logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail });
      this.persist();
    },
    blindArmAt(stratum: string, sequence: number): RegArm | undefined {
      return this.blind?.rows.find((row) => row.stratum === stratum && row.sequence === sequence)?.arm;
    },
    /** 本中心台账自己算组别所用的有效记录（中央侧记录不计入本地台账） */
    localActive(stratum: string): DispenseRecord[] {
      return this.records.filter(
        (item) => item.stratum === stratum && (item.origin === 'local' || item.origin === 'conflict-local') && (item.status === 'issued' || item.status === 'enrolled')
      );
    },
    /** 统一登记中占用编号的记录（含中央侧），用于取下一可用编号 */
    bookActive(stratum: string): DispenseRecord[] {
      return this.records.filter((item) => item.stratum === stratum && (item.status === 'issued' || item.status === 'enrolled'));
    },
    nextFreeSequence(stratum: string): number | undefined {
      if (!this.blind) return undefined;
      const occupied = new Set(this.bookActive(stratum).map((item) => item.sequence));
      const available = this.blind.rows
        .filter((row) => row.stratum === stratum && !occupied.has(row.sequence))
        .map((row) => row.sequence)
        .sort((a, b) => a - b);
      return available[0];
    },

    /** 首次导入：校验已在页面完成，直接登记版本 */
    acceptBlind(version: string, source: string, rows: BlindRow[], actor: string) {
      const blind: BlindVersion = { id: crypto.randomUUID(), version, source, rows, importedAt: new Date().toISOString(), importedBy: actor };
      this.blind = blind;
      this.log('盲底导入', `盲底 ${version}（${source}）首次导入通过：${rows.length} 条编号，分层 ${[...new Set(rows.map((r) => r.stratum))].join('、')}`, actor);
    },

    previewBlindUpdate(rows: BlindRow[]): UpdatePreview {
      const reissues: UpdatePreview['reissues'] = [];
      let voided = 0;
      let kept = 0;
      let enrolledWarnings = 0;
      for (const record of this.records) {
        if (record.status !== 'issued' && record.status !== 'enrolled') continue;
        const next = rows.find((row) => row.stratum === record.stratum && row.sequence === record.sequence);
        if (record.status === 'enrolled') {
          if (!next || next.arm !== record.blindArm) enrolledWarnings += 1;
          continue;
        }
        if (!next) {
          voided += 1;
          reissues.push({ stratum: record.stratum, oldSequence: record.sequence, oldArm: record.blindArm, reason: '新盲底已删除该编号' });
        } else if (next.arm !== record.blindArm) {
          voided += 1;
          reissues.push({ stratum: record.stratum, oldSequence: record.sequence, oldArm: record.blindArm, reason: `组别 ${record.blindArm}→${next.arm}` });
        } else {
          kept += 1;
        }
      }
      return { kept, voided, enrolledWarnings, reissues };
    },

    /** 盲底更新：发出未入组编号作废重排；已入组冻结，只报差异 */
    applyBlindUpdate(version: string, source: string, rows: BlindRow[], actor: string) {
      const preview = this.previewBlindUpdate(rows);
      const previousVersion = this.blind?.version ?? '旧版';
      this.blind = { id: crypto.randomUUID(), version, source, rows, importedAt: new Date().toISOString(), importedBy: actor };

      // 第一阶段：先统一判定并作废全部受影响的"已发号未入组"记录，
      // 避免逐条重排时把同批次即将作废的旧编号误当成空闲号。
      const toVoid: { record: DispenseRecord; reason: string }[] = [];
      for (const record of this.records) {
        if (record.status === 'voided' || record.status === 'blocked') continue;
        const next = rows.find((row) => row.stratum === record.stratum && row.sequence === record.sequence);
        if (record.status === 'enrolled') {
          if (!next) {
            this.log('盲底更新告警', `已入组编号 ${record.stratum}#${record.sequence} 在新盲底中缺失，按GCP冻结保留，不予作废（受试者 ${record.participantNo ?? '未登记'}）`, actor);
          } else if (next.arm !== record.blindArm) {
            this.log('盲底更新告警', `已入组编号 ${record.stratum}#${record.sequence} 组别 ${record.blindArm}→${next.arm}，冻结保留原分配，待与统计组核查`, actor);
          }
          continue;
        }
        if (record.status !== 'issued') continue;
        let reason = '';
        if (!next) reason = `盲底 ${previousVersion}→${version}：编号 ${record.sequence} 在新版中删除`;
        else if (next.arm !== record.blindArm) reason = `盲底 ${previousVersion}→${version}：编号 ${record.sequence} 组别 ${record.blindArm}→${next.arm}`;
        if (reason) toVoid.push({ record, reason });
      }

      // 按分层、编号顺序作废，保证重排按发号顺序取号
      toVoid.sort((a, b) => a.record.stratum.localeCompare(b.record.stratum) || a.record.sequence - b.record.sequence);
      for (const { record, reason } of toVoid) {
        record.status = 'voided';
        record.voidedReason = reason;
      }

      // 第二阶段：每条作废记录重排到新盲底中的下一可用编号
      for (const { record, reason } of toVoid) {
        const ticket: PendingReissue = {
          id: crypto.randomUUID(),
          voidedId: record.id,
          site: record.site,
          stratum: record.stratum,
          oldSequence: record.sequence,
          oldArm: record.blindArm,
          reason,
          createdAt: new Date().toISOString(),
          status: 'pending'
        };

        const newSequence = this.nextFreeSequence(record.stratum);
        if (newSequence === undefined) {
          ticket.note = '新版盲底该分层名额已满，待统计组补充盲底后再排';
        } else {
          const newArm = this.blindArmAt(record.stratum, newSequence);
          const localArm = computeLocalArm(this.localActive(record.stratum));
          const replacement: DispenseRecord = {
            id: crypto.randomUUID(),
            site: record.site,
            stratum: record.stratum,
            sequence: newSequence,
            blindArm: newArm!,
            localArm,
            participantNo: record.participantNo,
            subjectKey: record.subjectKey,
            status: 'issued',
            issuedAt: new Date().toISOString(),
            issuedBy: actor,
            blindVersion: version,
            origin: 'local',
            offline: record.offline,
            synced: record.synced,
            replacedFrom: record.id,
            note: `由作废编号 ${record.sequence} 重排`
          };
          record.replacedById = replacement.id;
          this.records.unshift(replacement);
          ticket.reissuedId = replacement.id;
          ticket.newSequence = newSequence;
          ticket.newArm = newArm;
          if (localArm !== newArm) {
            this.discrepancies.unshift({
              id: crypto.randomUUID(),
              type: 'renumber-arm-mismatch',
              at: new Date().toISOString(),
              actor: '系统',
              site: replacement.site,
              stratum: replacement.stratum,
              sequence: newSequence,
              blindArm: newArm!,
              localArm,
              detail: `作废重排：旧编号 ${record.sequence}（${record.blindArm}）重排为 ${newSequence}，本地台账算得 ${localArm}，与盲底 ${newArm} 不符，待确认`,
              status: 'open',
              dispenseId: replacement.id
            });
          }
        }
        this.reissues.unshift(ticket);
      }

      this.log('盲底更新', `盲底升级 ${previousVersion}→${version}：保留 ${preview.kept}，作废重排 ${preview.voided}，已入组冻结告警 ${preview.enrolledWarnings}`, actor);
      this.persist();
    },

    /** 发号：以盲底取组别；本地算的对不上则拦下并留差异 */
    issue(site: string, stratum: string, participantNo: string, subjectKey: string, actor: string, offline: boolean): IssueResult {
      if (!this.blind) return { ok: false, message: '尚未导入有效盲底，无法发号' };
      const sequence = this.nextFreeSequence(stratum);
      if (sequence === undefined) return { ok: false, message: `分层「${stratum}」盲底名额已用尽` };
      const blindArm = this.blindArmAt(stratum, sequence)!;
      const localArm = computeLocalArm(this.localActive(stratum));

      const base = {
        id: crypto.randomUUID(),
        site,
        stratum,
        sequence,
        blindArm,
        localArm,
        participantNo: participantNo || undefined,
        subjectKey: subjectKey || undefined,
        issuedAt: new Date().toISOString(),
        issuedBy: actor,
        blindVersion: this.blind.version
      };

      if (localArm !== blindArm) {
        const blocked: DispenseRecord = { ...base, status: 'blocked', origin: 'local', offline, synced: !offline, note: '发号被拦截：本地台账组别与盲底不符' };
        this.records.unshift(blocked);
        const diff: Discrepancy = {
          id: crypto.randomUUID(),
          type: 'arm-mismatch-block',
          at: new Date().toISOString(),
          actor,
          site,
          stratum,
          sequence,
          blindArm,
          localArm,
          detail: `拟发编号 ${sequence}：盲底组别 ${blindArm}，本地台账算得 ${localArm}，已拦下，编号未占用`,
          status: 'open',
          dispenseId: blocked.id
        };
        this.discrepancies.unshift(diff);
        this.log('发号拦截', `${site}「${stratum}」拟发 ${sequence}：盲底=${blindArm}，本地=${localArm}，拦截并登记差异`, actor);
        return { ok: false, message: `已拦下：盲底组别 ${blindArm} 与本地计算 ${localArm} 不符，差异已留档（编号未发出）`, discrepancyId: diff.id };
      }

      const record: DispenseRecord = { ...base, status: 'issued', origin: 'local', offline, synced: !offline };
      this.records.unshift(record);
      this.log(offline ? '离线发号' : '发号', `${site}「${stratum}」发出编号 ${sequence}（盲底组别 ${blindArm}，与本地一致）${offline ? '，断网暂存本中心' : ''}`, actor);
      return { ok: true, message: offline ? `离线暂存：编号 ${sequence}（${blindArm}），恢复后按顺序合并` : `发号成功：编号 ${sequence}，组别以盲底为准 = ${blindArm}`, recordId: record.id, sequence, arm: blindArm };
    },

    enroll(id: string, participantNo: string, subjectKey: string, actor: string): IssueResult {
      const record = this.records.find((item) => item.id === id);
      if (!record) return { ok: false, message: '记录不存在' };
      if (record.status === 'voided') return { ok: false, message: '该编号已作废，不能入组' };
      if (record.status === 'blocked') return { ok: false, message: '该编号存在未处理差异并被拦截，不能入组' };
      if (record.status === 'enrolled') return { ok: false, message: '该编号已入组' };
      if (!participantNo.trim()) return { ok: false, message: '请填写受试者编号' };
      const duplicated = this.records.some((item) => item.id !== id && item.status !== 'voided' && item.participantNo === participantNo.trim());
      if (duplicated) return { ok: false, message: `受试者编号 ${participantNo} 已在登记中，拒绝重复入组` };
      record.participantNo = participantNo.trim();
      record.subjectKey = subjectKey.trim() || record.subjectKey;
      record.status = 'enrolled';
      record.enrolledAt = new Date().toISOString();
      this.log('入组登记', `${record.site}「${record.stratum}」编号 ${record.sequence} 受试者 ${participantNo} 入组`, actor);
      return { ok: true, message: `入组成功：编号 ${record.sequence}` };
    },

    /** 差异处置：arm 类差异放行被拦记录（须填原因，差异永久留档）；冲突类仅登记处置结论 */
    resolveDiscrepancy(id: string, resolution: string, actor: string) {
      const diff = this.discrepancies.find((item) => item.id === id);
      if (!diff || diff.status !== 'open' || !resolution.trim()) return;
      diff.status = 'resolved';
      diff.resolution = resolution.trim();
      diff.resolvedAt = new Date().toISOString();
      diff.resolvedBy = actor;
      if ((diff.type === 'arm-mismatch-block' || diff.type === 'renumber-arm-mismatch') && diff.dispenseId) {
        const record = this.records.find((item) => item.id === diff.dispenseId);
        if (record && record.status === 'blocked') {
          // 拦截期间编号不占用；放行时若拟发编号已被他单占用，则改取当前下一可用编号
          const takenByAnother = this.bookActive(record.stratum).some((item) => item.sequence === record.sequence && item.id !== record.id);
          if (takenByAnother) {
            const nextSequence = this.nextFreeSequence(record.stratum);
            if (nextSequence !== undefined) {
              const nextArm = this.blindArmAt(record.stratum, nextSequence)!;
              record.note = `差异授权放行：原拟发编号 ${record.sequence} 已被占用，改取 ${nextSequence}`;
              record.sequence = nextSequence;
              record.blindArm = nextArm;
            }
          } else {
            record.note = `差异经授权处置后放行（盲底 ${record.blindArm} / 本地 ${record.localArm}）`;
          }
          record.status = 'issued';
          this.log('差异处置放行', `「${record.stratum}」编号 ${record.sequence} 经授权放行发号，原因：${resolution.trim()}`, actor);
        } else if (record) {
          this.log('差异处置', `「${record.stratum}」编号 ${record.sequence} 差异确认，处置结论：${resolution.trim()}`, actor);
        }
      } else {
        this.log('冲突处置', `「${diff.stratum}」编号 ${diff.sequence} 合并冲突处置：${resolution.trim()}`, actor);
      }
      this.persist();
    },

    confirmReissue(id: string, actor: string) {
      const ticket = this.reissues.find((item) => item.id === id);
      if (!ticket || ticket.status !== 'pending') return;
      ticket.status = 'confirmed';
      ticket.confirmedAt = new Date().toISOString();
      ticket.confirmedBy = actor;
      this.log('重排确认', `「${ticket.stratum}」旧编号 ${ticket.oldSequence} 的重排编号 ${ticket.newSequence ?? '（待补盲底）'} 已确认`, actor);
    },

    discardReissue(id: string, actor: string) {
      const ticket = this.reissues.find((item) => item.id === id);
      if (!ticket || ticket.status !== 'pending') return;
      ticket.status = 'discarded';
      if (ticket.reissuedId) {
        const reissued = this.records.find((item) => item.id === ticket.reissuedId);
        if (reissued && reissued.status === 'issued') {
          reissued.status = 'voided';
          reissued.voidedReason = '重排编号被本中心拒绝确认';
        }
      }
      this.log('重排拒绝', `「${ticket.stratum}」旧编号 ${ticket.oldSequence} 的重排被拒绝，新编号作废`, actor);
    },

    /** 断网恢复：离线记录按发号时间顺序与中央侧合并；冲突两边都留 */
    syncNow(actor: string): SyncSummary {
      const queued = this.offlineQueue
        .slice()
        .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));

      if (queued.length === 0 && !this.blind) return { sent: 0, conflicts: 0, centralIncoming: 0 };

      const central: DispenseRecord[] = [];
      const now = Date.now();
      const makeCentral = (stratum: string, sequence: number, participantNo: string, at: string): DispenseRecord => ({
        id: crypto.randomUUID(),
        site: '中央/其他中心',
        stratum,
        sequence,
        blindArm: this.blindArmAt(stratum, sequence) ?? 'A',
        localArm: this.blindArmAt(stratum, sequence) ?? 'A',
        participantNo,
        subjectKey: `CENTRAL-${sequence}`,
        status: 'issued',
        issuedAt: at,
        issuedBy: '中央随机系统',
        blindVersion: this.blind?.version ?? '',
        origin: 'central',
        offline: false,
        synced: true
      });

      // 模拟中央侧：与本中心第一条离线记录抢同一编号（冲突），另下发一条不冲突记录
      if (queued.length > 0) {
        const clash = queued[0];
        central.push(makeCentral(clash.stratum, clash.sequence, `CENTRAL-${clash.stratum}-${clash.sequence}`, new Date(now - 60_000).toISOString()));
      }
      if (this.blind) {
        const targetStratum = [...new Set(this.blind.rows.map((row) => row.stratum))][0];
        if (targetStratum) {
          const occupied = new Set([
            ...this.bookActive(targetStratum).map((item) => item.sequence),
            ...queued.filter((item) => item.stratum === targetStratum).map((item) => item.sequence),
            ...central.filter((item) => item.stratum === targetStratum).map((item) => item.sequence)
          ]);
          const free = this.blind.rows
            .filter((row) => row.stratum === targetStratum && !occupied.has(row.sequence))
            .map((row) => row.sequence)
            .sort((a, b) => a - b)[0];
          if (free !== undefined) central.push(makeCentral(targetStratum, free, `CENTRAL-${targetStratum}-${free}`, new Date(now - 30_000).toISOString()));
        }
      }

      let conflicts = 0;
      // 按发号顺序逐条比对（中央记录时间早于本次同步，视同已在库）
      for (const localRecord of queued) {
        const clash = central.find(
          (item) => item.stratum === localRecord.stratum &&
            item.sequence === localRecord.sequence &&
            (item.status === 'issued' || item.status === 'enrolled')
        );
        const subjectClash = central.find(
          (item) => item.participantNo && item.participantNo === localRecord.participantNo
        );
        const rival = clash ?? subjectClash;
        if (rival) {
          conflicts += 1;
          localRecord.origin = 'conflict-local';
          localRecord.synced = true;
          localRecord.note = `同步冲突：中央侧 ${rival.site} 已占用 ${rival.stratum}#${rival.sequence}（受试者 ${rival.participantNo ?? '未登记'}），本地记录保留待处置`;
          rival.origin = 'conflict-central';
          rival.note = `同步冲突：本中心离线发出 ${localRecord.stratum}#${localRecord.sequence}（受试者 ${localRecord.participantNo ?? '未登记'}），中央侧记录保留待处置`;
          this.discrepancies.unshift({
            id: crypto.randomUUID(),
            type: 'sync-conflict',
            at: new Date().toISOString(),
            actor,
            site: localRecord.site,
            stratum: localRecord.stratum,
            sequence: localRecord.sequence,
            blindArm: rival.blindArm,
            localArm: localRecord.blindArm,
            detail: `编号 ${localRecord.stratum}#${localRecord.sequence} 合并冲突：本地(${localRecord.participantNo ?? '未登记'}) 与中央(${rival.participantNo ?? '未登记'})，两边记录均保留`,
            status: 'open',
            dispenseId: localRecord.id,
            pairedDispenseId: rival.id
          });
        } else {
          localRecord.offline = false;
          localRecord.synced = true;
        }
      }
      // 中央侧记录全部入统一登记（冲突件也保留）
      central.forEach((item) => this.records.push(item));

      this.log('联网合并', `恢复同步：上送 ${queued.length} 条，按发号顺序合并；冲突 ${conflicts} 条（两边都留）；中央侧新增 ${central.length} 条`, actor);
      return { sent: queued.length, conflicts, centralIncoming: central.length };
    }
  }
});

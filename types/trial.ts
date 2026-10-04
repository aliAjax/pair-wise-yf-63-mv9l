export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';

/** 分层键：中心 | 年龄层 */
export type StratumKey = string;

/** 盲底编号使用状态 */
export type BlindCodeStatus = 'available' | 'issued' | 'void';

/** 盲底条目：统计组下发的随机登记项 */
export interface BlindCode {
  code: number;
  stratum: StratumKey;
  site: string;
  ageBand: AgeBand;
  /** 区组号，同一分层内从 1 连续编号 */
  block: number;
  arm: Arm;
  status: BlindCodeStatus;
}

/** 盲底表（带版本，更新后 +1） */
export interface BlindList {
  version: number;
  importedAt: string;
  source: string;
  codes: BlindCode[];
}

/** 发号台账状态：已发号未入组 / 已入组 / 已作废 / 已揭盲 */
export type IssuedStatus = 'issued' | 'enrolled' | 'void' | 'unblinded';

/** 断网合并状态：待合并 / 已合并 / 冲突（两边都留） */
export type MergeState = 'pending' | 'merged' | 'conflict';

/** 发号台账记录：中心发号以盲底为准，本地组别仅用于对账 */
export interface IssuedRecord {
  id: string;
  code: number;
  stratum: StratumKey;
  site: string;
  ageBand: AgeBand;
  block: number;
  /** 盲底组别（发号基准） */
  arm: Arm;
  /** 本地计算组别（对不上时拦下留差异） */
  localArm: Arm;
  participantNo: string;
  identityKey: string;
  status: IssuedStatus;
  /** 盲底更新后已发号未入组、作废重排，等待中心确认 */
  pendingConfirm: boolean;
  voidReason?: string;
  voidedAt?: string;
  issuedAt: string;
  enrolledAt?: string;
  confirmedAt?: string;
  unblindedAt?: string;
  actor: string;
  offline: boolean;
  mergeState: MergeState;
  /** 断网期间的本地顺序号，恢复后按顺序合并 */
  localSeq: number;
}

/** 组别差异：本地计算与盲底不一致时拦下并留档 */
export interface Discrepancy {
  id: string;
  at: string;
  actor: string;
  participantNo: string;
  stratum: StratumKey;
  blindArm: Arm;
  localArm: Arm;
  detail: string;
}

/** 断网合并冲突：本地一边与服务器一边都保留 */
export interface MergeConflict {
  id: string;
  at: string;
  /** 本地（中心）一边 */
  localSide: { participantNo: string; code: number; arm: Arm; localSeq: number };
  /** 服务器（合并后）一边 */
  serverSide: { participantNo?: string; code: number; arm: Arm };
  detail: string;
}

export type AuditAction =
  | 'blind-imported'
  | 'blind-rejected'
  | 'blind-updated'
  | 'number-issued'
  | 'issue-blocked'
  | 'duplicate-blocked'
  | 'enrolled'
  | 'unblinded'
  | 'voided'
  | 'reissued'
  | 'pending-confirmed'
  | 'offline-queued'
  | 'offline-merged'
  | 'merge-conflict';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export interface IssueInput {
  site: string;
  ageBand: AgeBand;
  participantNo: string;
  identityKey: string;
  actor: string;
}

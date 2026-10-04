export type RegArm = 'A' | 'B';

/** 盲底一行：分层 + 区组 + 编号 + 组别（以盲底为准） */
export interface BlindRow {
  stratum: string;
  block: number;
  sequence: number;
  arm: RegArm;
}

export interface BlindVersion {
  id: string;
  version: string;
  source: string;
  importedAt: string;
  importedBy: string;
  rows: BlindRow[];
}

/** 中心发号台账记录状态 */
export type DispenseStatus =
  | 'issued'      // 已发号、待入组
  | 'enrolled'    // 已入组
  | 'voided'      // 盲底更新后作废
  | 'blocked';    // 本地组别与盲底不符被拦下

export type RecordOrigin =
  | 'local'               // 本中心发出
  | 'central'             // 同步自主管/中央台
  | 'conflict-local'      // 冲突：本中心侧
  | 'conflict-central';   // 冲突：中央侧（两边都留）

export interface DispenseRecord {
  id: string;
  site: string;
  stratum: string;
  /** 发号编号，取自盲底；blocked 记录为拟发编号，不占名额 */
  sequence: number;
  blindArm: RegArm;
  /** 本中心台账自己算的组别 */
  localArm: RegArm;
  participantNo?: string;
  subjectKey?: string;
  status: DispenseStatus;
  issuedAt: string;
  issuedBy: string;
  enrolledAt?: string;
  blindVersion: string;
  origin: RecordOrigin;
  offline: boolean;
  synced: boolean;
  voidedReason?: string;
  replacedById?: string;   // 作废后重排的新记录
  replacedFrom?: string;   // 本记录由哪条作废记录重排而来
  note?: string;
}

export type DiffType =
  | 'arm-mismatch-block'     // 发号时本地组别与盲底不符
  | 'renumber-arm-mismatch'  // 盲底更新重排后仍不符
  | 'sync-conflict';         // 联网合并冲突（编号/受试者占用）

export type DiffStatus = 'open' | 'resolved' | 'discarded';

export interface Discrepancy {
  id: string;
  type: DiffType;
  at: string;
  actor: string;
  site: string;
  stratum: string;
  sequence: number;
  blindArm: RegArm;
  localArm: RegArm;
  detail: string;
  status: DiffStatus;
  dispenseId?: string;
  pairedDispenseId?: string;
  resolution?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export type ReissueStatus = 'pending' | 'confirmed' | 'discarded';

/** 盲底更新后：发出未入组编号作废重排，等待本中心确认 */
export interface PendingReissue {
  id: string;
  voidedId: string;
  reissuedId?: string;
  site: string;
  stratum: string;
  oldSequence: number;
  oldArm: RegArm;
  newSequence?: number;
  newArm?: RegArm;
  reason: string;
  createdAt: string;
  status: ReissueStatus;
  confirmedAt?: string;
  confirmedBy?: string;
  note?: string;
}

export interface RegisterLog {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface BlindImportIssue {
  line: number;
  message: string;
}

export interface BlindParseResult {
  ok: boolean;
  rows: BlindRow[];
  issues: BlindImportIssue[];
}

export interface UpdatePreview {
  kept: number;
  voided: number;
  enrolledWarnings: number;
  reissues: { stratum: string; oldSequence: number; oldArm: RegArm; newSequence?: number; newArm?: RegArm; reason: string }[];
}

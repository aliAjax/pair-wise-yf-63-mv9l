<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore, SITES, AGE_BANDS } from '~/stores/trial';
import { buildValidBlindCsv, buildBrokenBlindCsv } from '~/utils/blindSamples';
import type { TrialRole, Arm, AgeBand, Discrepancy } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { blind, ledger, discrepancies, conflicts, audits } = storeToRefs(trial);

const role = ref<TrialRole>('investigator');
const offline = ref(false);
const actor = ref('研究者张宁');

/* ---- 盲底导入 ---- */
const blindRaw = ref('');
const blindSource = ref('统计组盲底');
const importErrors = ref<string[]>([]);
const importBlind = () => {
  const result = trial.importBlindList(blindRaw.value, blindSource.value, actor.value);
  if (result.ok) {
    ElMessage.success(`盲底 v${result.version} 已入账；已发号未入组记录作废重排，请在待确认列表核对`);
    importErrors.value = [];
    blindRaw.value = '';
  } else {
    importErrors.value = result.errors ?? [];
    ElMessage.error('校验不通过，整份已退回');
  }
};
const loadSample = (kind: 'valid' | 'broken') => {
  blindRaw.value = kind === 'valid' ? buildValidBlindCsv() : buildBrokenBlindCsv();
  importErrors.value = [];
};

/* ---- 中心发号 ---- */
const issueForm = ref<{ site: string; ageBand: AgeBand; participantNo: string; identityKey: string }>({
  site: '上海中心', ageBand: '45-64', participantNo: '', identityKey: ''
});
const lastBlocked = ref<Discrepancy | null>(null);
const issue = () => {
  if (!issueForm.value.participantNo.trim() || !issueForm.value.identityKey.trim()) {
    ElMessage.warning('请填写受试者编号与身份核验标识');
    return;
  }
  const result = trial.issueNumber({ ...issueForm.value, actor: actor.value }, offline.value);
  if (result.ok) {
    ElMessage.success(result.message);
    lastBlocked.value = null;
    issueForm.value.participantNo = '';
    issueForm.value.identityKey = '';
  } else {
    ElMessage.error(result.message);
    lastBlocked.value = result.blocked ? (result.discrepancy ?? null) : null;
  }
};

/* ---- 断网与合并 ---- */
const mergeNow = () => {
  const result = trial.mergeOffline(actor.value);
  ElMessage.info(`联网合并完成：${result.merged} 条入库，${result.conflicts} 条冲突（两边都留）`);
};
watch(offline, (val) => {
  if (!val && trial.offlinePendingCount > 0) mergeNow();
});

/* ---- 台账操作 ---- */
const enroll = (id: string) => trial.enroll(id, actor.value);
const confirmPending = (id: string) => trial.confirmPending(id, actor.value);
const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (v: string) => Boolean(v?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认并审计'
    });
    trial.emergencyUnblind(id, value, actor.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch { /* 取消 */ }
};

/* ---- 角色隔离：药品管理员可见组别，研究者隐藏，监察员仅揭盲后可见 ---- */
const visibleArm = (arm: Arm, status: string) => {
  if (role.value === 'pharmacist') return arm;
  if (role.value === 'monitor' && status === 'unblinded') return arm;
  return '已隐藏';
};

const armTagType = (arm: Arm) => (arm === 'A' ? 'primary' : 'success');
const statusTagType = (status: string) =>
  status === 'enrolled' ? 'success' : status === 'issued' ? 'warning' : status === 'void' ? 'info' : 'danger';
const mergeTagType = (state: string) =>
  state === 'merged' ? 'success' : state === 'pending' ? 'warning' : 'danger';

const counts = computed(() => ({
  version: trial.blindVersion,
  issued: trial.issuedCount,
  enrolled: trial.enrolledCount,
  pendingConfirm: trial.pendingConfirmCount,
  discrepancies: trial.discrepancyCount,
  conflicts: trial.conflictCount,
  offlinePending: trial.offlinePendingCount
}));

const pendingList = computed(() => ledger.value.filter((r) => r.status === 'issued' && r.pendingConfirm));
const fmt = (s?: string) => (s ? new Date(s).toLocaleString() : '—');
</script>

<template>
  <main class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP 盲底对账原型</el-tag>
        <h1>{{ t('title') }}</h1>
        <p>{{ t('subtitle') }}</p>
      </div>
      <el-segmented v-model="role" :options="[
        { label: '研究者', value: 'investigator' },
        { label: '药品管理员', value: 'pharmacist' },
        { label: '监察员', value: 'monitor' }
      ]" />
    </header>

    <section class="stats">
      <div class="stat"><span>盲底版本</span><b>v{{ counts.version }}</b></div>
      <div class="stat"><span>已发号未入组</span><b>{{ counts.issued }}</b></div>
      <div class="stat"><span>已入组</span><b>{{ counts.enrolled }}</b></div>
      <div class="stat"><span>待确认</span><b>{{ counts.pendingConfirm }}</b></div>
      <div class="stat"><span>组别差异</span><b>{{ counts.discrepancies }}</b></div>
      <div class="stat"><span>合并冲突</span><b>{{ counts.conflicts }}</b></div>
    </section>

    <div class="grid">
      <!-- 盲底表 -->
      <el-card shadow="never">
        <template #header>
          <b>{{ t('blind') }}（统计组下发）</b>
          <el-tag v-if="blind" type="info" style="float:right">v{{ blind.version }} · {{ blind.source }}</el-tag>
        </template>
        <el-alert v-if="importErrors.length" type="error" :closable="false" title="整份退回：校验不通过，未入账" style="margin-bottom:10px">
          <div v-for="(e, i) in importErrors" :key="i">· {{ e }}</div>
        </el-alert>
        <el-input v-model="blindRaw" type="textarea" :rows="5" placeholder="粘贴统计组盲底：JSON 数组或 CSV（code,stratum,block,arm）" />
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <el-button type="primary" @click="importBlind">导入并校验</el-button>
          <el-button @click="loadSample('valid')">示例（有效）</el-button>
          <el-button @click="loadSample('broken')">示例（含错）</el-button>
          <el-input v-model="blindSource" size="small" style="width:200px" placeholder="来源" />
        </div>
        <el-table :data="blind?.codes ?? []" max-height="300" style="margin-top:12px" size="small">
          <el-table-column prop="code" label="编号" width="80" />
          <el-table-column prop="stratum" label="分层（中心 | 年龄层）" min-width="180" />
          <el-table-column prop="block" label="区组" width="70" />
          <el-table-column label="组别" width="80">
            <template #default="{ row }"><el-tag :type="armTagType(row.arm)" size="small">{{ row.arm }}</el-tag></template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'available' ? 'success' : row.status === 'issued' ? 'warning' : 'info'" size="small">
                {{ row.status === 'available' ? '可用' : row.status === 'issued' ? '已占' : '作废' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 中心发号 -->
      <el-card shadow="never">
        <template #header>
          <b>{{ t('issue') }}（以盲底为准）</b>
          <el-switch v-model="offline" active-text="模拟断网" inline-prompt style="float:right" />
        </template>
        <el-form label-position="top" @submit.prevent="issue">
          <el-form-item label="研究中心">
            <el-select v-model="issueForm.site" style="width:100%">
              <el-option v-for="s in SITES" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="年龄分层">
            <el-radio-group v-model="issueForm.ageBand">
              <el-radio-button v-for="a in AGE_BANDS" :key="a" :value="a">{{ a }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="受试者编号"><el-input v-model="issueForm.participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识"><el-input v-model="issueForm.identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="操作人"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">发号（组别取盲底，本地不一致自动拦下）</el-button>
        </el-form>
        <el-alert v-if="lastBlocked" type="warning" :closable="false" title="已拦下：本地组别与盲底不一致" style="margin-top:10px">
          <div>盲底组别 <b>{{ lastBlocked.blindArm }}</b> ｜ 本地计算 <b>{{ lastBlocked.localArm }}</b></div>
          <div>差异已留档（{{ lastBlocked.participantNo }}），请联系统计组核对，不得自行发号。</div>
        </el-alert>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <!-- 发号台账 -->
      <el-card shadow="never">
        <template #header><b>{{ t('ledger') }}（可对账登记）</b></template>
        <el-table :data="ledger" max-height="460" size="small">
          <el-table-column prop="code" label="编号" width="80" />
          <el-table-column prop="stratum" label="分层" min-width="170" />
          <el-table-column prop="block" label="区组" width="65" />
          <el-table-column label="盲底组" width="75">
            <template #default="{ row }"><el-tag :type="armTagType(row.arm)" size="small">{{ row.arm }}</el-tag></template>
          </el-table-column>
          <el-table-column label="本地组" width="75">
            <template #default="{ row }">
              <el-tag :type="row.localArm === row.arm ? 'info' : 'danger'" size="small" effect="plain">{{ row.localArm }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ row.status === 'enrolled' ? '已入组' : row.status === 'issued' ? (row.pendingConfirm ? '待确认' : '已发号') : row.status === 'void' ? '已作废' : '已揭盲' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column label="发号时间" width="150">
            <template #default="{ row }">{{ fmt(row.issuedAt) }}</template>
          </el-table-column>
          <el-table-column label="合并" width="85">
            <template #default="{ row }">
              <el-tag v-if="row.offline || row.mergeState !== 'merged'" :type="mergeTagType(row.mergeState)" size="small">
                {{ row.mergeState === 'pending' ? '待合并' : row.mergeState === 'conflict' ? '冲突' : '已合并' }}
              </el-tag>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'issued' && !row.pendingConfirm" size="small" type="success" plain @click="enroll(row.id)">入组</el-button>
              <el-button v-if="row.status === 'issued' && row.pendingConfirm" size="small" type="warning" plain @click="confirmPending(row.id)">确认</el-button>
              <el-button v-if="role === 'investigator' && (row.status === 'enrolled')" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <div>
        <!-- 待确认 -->
        <el-card shadow="never">
          <template #header><b>{{ t('pendingConfirm') }}（盲底更新后作废重排）</b></template>
          <el-empty v-if="pendingList.length === 0" description="暂无待确认记录" :image-size="60" />
          <el-table v-else :data="pendingList" size="small">
            <el-table-column prop="participantNo" label="受试者" min-width="100" />
            <el-table-column prop="code" label="新编号" width="85" />
            <el-table-column label="盲底组" width="80">
              <template #default="{ row }"><el-tag :type="armTagType(row.arm)" size="small">{{ row.arm }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="voidReason" label="原因" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="75">
              <template #default="{ row }"><el-button size="small" type="warning" plain @click="confirmPending(row.id)">确认</el-button></template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- 差异记录 -->
        <el-card shadow="never" style="margin-top:20px">
          <template #header><b>{{ t('discrepancy') }}（拦下留档，可对账）</b></template>
          <el-empty v-if="discrepancies.length === 0" description="暂无差异" :image-size="60" />
          <el-table v-else :data="discrepancies" max-height="260" size="small">
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ fmt(row.at) }}</template>
            </el-table-column>
            <el-table-column prop="participantNo" label="受试者" width="100" />
            <el-table-column prop="stratum" label="分层" min-width="150" />
            <el-table-column label="盲底" width="70">
              <template #default="{ row }"><el-tag :type="armTagType(row.blindArm)" size="small">{{ row.blindArm }}</el-tag></template>
            </el-table-column>
            <el-table-column label="本地" width="70">
              <template #default="{ row }"><el-tag type="danger" size="small" effect="plain">{{ row.localArm }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="detail" label="差异说明" min-width="200" show-overflow-tooltip />
          </el-table>
        </el-card>
      </div>
    </div>

    <div class="grid" style="margin-top:20px">
      <!-- 合并冲突 -->
      <el-card shadow="never">
        <template #header>
          <b>{{ t('conflict') }}（断网合并，两边都留）</b>
          <el-button size="small" type="primary" style="float:right" :disabled="counts.offlinePending === 0" @click="mergeNow">
            {{ t('reconcile') }}（{{ counts.offlinePending }}）
          </el-button>
        </template>
        <el-empty v-if="conflicts.length === 0" description="暂无合并冲突" :image-size="60" />
        <el-table v-else :data="conflicts" max-height="320" size="small">
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ fmt(row.at) }}</template>
          </el-table-column>
          <el-table-column label="本地一边（中心）" min-width="180">
            <template #default="{ row }">
              {{ row.localSide.participantNo }} 发号 {{ row.localSide.code }}（{{ row.localSide.arm }}）
            </template>
          </el-table-column>
          <el-table-column label="服务器一边" min-width="180">
            <template #default="{ row }">
              <span v-if="row.serverSide.participantNo">{{ row.serverSide.participantNo }} 占用 {{ row.serverSide.code }}（{{ row.serverSide.arm }}）</span>
              <span v-else>编号 {{ row.serverSide.code }} 不可用（{{ row.serverSide.arm }}）</span>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="说明" min-width="220" show-overflow-tooltip />
        </el-table>
      </el-card>

      <!-- 审计日志 -->
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item
            v-for="entry in audits"
            :key="entry.id"
            :timestamp="fmt(entry.at)"
            :type="entry.action === 'issue-blocked' || entry.action === 'merge-conflict' || entry.action === 'blind-rejected'
              ? 'danger'
              : entry.action === 'voided' || entry.action === 'reissued' || entry.action === 'unblinded'
                ? 'warning'
                : 'primary'"
          >
            <b>{{ entry.actor }} · {{ entry.action }}</b>
            <div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>

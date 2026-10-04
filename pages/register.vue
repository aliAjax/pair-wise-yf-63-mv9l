<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRegisterStore } from '~/stores/register';
import { parseBlindCsv } from '~/composables/useBlindImport';
import { BLIND_SAMPLE_V1, BLIND_SAMPLE_V2, BLIND_SAMPLE_BAD } from '~/data/blindSamples';
import type { UploadFile } from 'element-plus';
import type { DispenseRecord, Discrepancy } from '~/types/register';

const register = useRegisterStore();
const { blind, records, discrepancies, reissues, logs } = storeToRefs(register);

const actor = ref('研究者张宁');
const site = ref('上海中心');
const tab = ref('blind');

// —— 盲底导入 ——
const csvText = ref('');
const version = ref('v1.0');
const source = ref('统计组盲底表');
const pendingRows = ref<ReturnType<typeof parseBlindCsv>['rows']>([]);
const importIssues = ref<{ line: number; message: string }[]>([]);
const updatePreview = ref<ReturnType<typeof register.previewBlindUpdate> | null>(null);

const validateCsv = () => {
  const result = parseBlindCsv(csvText.value);
  importIssues.value = result.issues;
  updatePreview.value = null;
  if (!result.ok) {
    pendingRows.value = [];
    register.log('盲底退回', `盲底 ${version.value} 校验失败整份退回：${result.issues.map((i) => i.message).join('；')}`, actor.value);
    ElMessage.error({ message: `校验未通过，整份退回（${result.issues.length} 处错误）`, duration: 4000 });
    return;
  }
  pendingRows.value = result.rows;
  if (blind.value) {
    updatePreview.value = register.previewBlindUpdate(result.rows);
  }
  ElMessage.success(`校验通过：${result.rows.length} 条编号`);
};

const onFile = (file: UploadFile) => {
  if (!file.raw) return false;
  const reader = new FileReader();
  reader.onload = () => {
    csvText.value = String(reader.result ?? '');
    ElMessage.info('文件已载入，点击「校验盲底」进行分层区组检查');
  };
  reader.readAsText(file.raw, 'utf-8');
  return false;
};

const confirmImport = () => {
  if (pendingRows.value.length === 0) return;
  if (blind.value) {
    register.applyBlindUpdate(version.value, source.value, pendingRows.value, actor.value);
    ElMessage.success('新版盲底已生效，发出未入组编号已作废重排，请在「作废重排」页确认');
    tab.value = 'reissue';
  } else {
    register.acceptBlind(version.value, source.value, pendingRows.value, actor.value);
    ElMessage.success('盲底已登记，发号将以盲底组别为准');
  }
  pendingRows.value = [];
  updatePreview.value = null;
  importIssues.value = [];
};

const loadSample = (kind: 'v1' | 'v2' | 'bad') => {
  if (kind === 'v1') { csvText.value = BLIND_SAMPLE_V1; version.value = 'v1.0'; }
  if (kind === 'v2') { csvText.value = BLIND_SAMPLE_V2; version.value = 'v2.0'; }
  if (kind === 'bad') { csvText.value = BLIND_SAMPLE_BAD; version.value = 'v1.0-错误'; }
  importIssues.value = [];
  pendingRows.value = [];
  updatePreview.value = null;
};

// —— 发号 ——
const stratum = ref('');
const participantNo = ref('');
const subjectKey = ref('');
const offline = ref(false);

const issue = () => {
  if (!stratum.value) { ElMessage.error('请选择分层'); return; }
  const result = register.issue(site.value, stratum.value, participantNo.value, subjectKey.value, actor.value, offline.value);
  if (result.ok) {
    ElMessage.success(result.message);
    participantNo.value = '';
    subjectKey.value = '';
  } else {
    ElMessage.error(result.message);
    tab.value = 'diff';
  }
};

// —— 入组 / 差异处置 ——
const enroll = async (row: DispenseRecord) => {
  try {
    const { value } = await ElMessageBox.prompt(`确认编号 ${row.sequence} 入组，请填写受试者编号`, '入组登记', {
      confirmButtonText: '确认入组',
      inputValue: row.participantNo ?? '',
      inputValidator: (value) => Boolean(value?.trim()) || '受试者编号不能为空'
    });
    const result = register.enroll(row.id, value, row.subjectKey ?? '', actor.value);
    result.ok ? ElMessage.success(result.message) : ElMessage.error(result.message);
  } catch {}
};

const resolveDiff = async (row: Discrepancy) => {
  try {
    const { value } = await ElMessageBox.prompt(`处置「${row.stratum}」编号 ${row.sequence} 的差异，请填写处置原因（将永久留档）`, '差异处置', {
      inputType: 'textarea',
      confirmButtonText: '确认处置',
      inputValidator: (value) => Boolean(value?.trim()) || '处置原因不能为空'
    });
    register.resolveDiscrepancy(row.id, value, actor.value);
    ElMessage.warning('差异已处置并留档');
  } catch {}
};

const confirmReissue = (id: string) => { register.confirmReissue(id, actor.value); ElMessage.success('重排编号已确认'); };
const discardReissue = async (id: string) => {
  try {
    await ElMessageBox.confirm('拒绝该重排编号？新编号将作废，旧编号需联系统计组处理。', '待确认重排', { type: 'warning' });
    register.discardReissue(id, actor.value);
  } catch {}
};

const syncNow = () => {
  const summary = register.syncNow(actor.value);
  ElMessage.success(`同步完成：上送 ${summary.sent} 条，冲突 ${summary.conflicts} 条（两边都留），中央新增 ${summary.centralIncoming} 条`);
  if (summary.conflicts > 0) tab.value = 'diff';
};

// —— 台账筛选与统计 ——
const ledgerFilter = ref('all');
const filteredRecords = computed(() => {
  const list = records.value.slice().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  if (ledgerFilter.value === 'all') return list;
  if (ledgerFilter.value === 'local') return list.filter((i) => i.origin === 'local' || i.origin === 'conflict-local');
  return list.filter((i) => i.status === ledgerFilter.value);
});

const stats = computed(() => ({
  issued: records.value.filter((i) => i.status === 'issued').length,
  enrolled: records.value.filter((i) => i.status === 'enrolled').length,
  blocked: records.value.filter((i) => i.status === 'blocked').length,
  voided: records.value.filter((i) => i.status === 'voided').length,
  offline: register.offlineQueue.length,
  openDiff: discrepancies.value.filter((i) => i.status === 'open').length,
  pendingReissue: register.pendingReissues.length
}));

const statusMeta: Record<string, { label: string; type: 'info' | 'success' | 'warning' | 'danger' | 'primary' }> = {
  issued: { label: '待入组', type: 'primary' },
  enrolled: { label: '已入组', type: 'success' },
  blocked: { label: '已拦截', type: 'danger' },
  voided: { label: '已作废', type: 'info' }
};

const originLabel: Record<string, string> = {
  local: '本中心',
  central: '中央侧',
  'conflict-local': '冲突·本中心',
  'conflict-central': '冲突·中央侧'
};

const diffTypeLabel: Record<string, string> = {
  'arm-mismatch-block': '发号组别不符',
  'renumber-arm-mismatch': '重排组别不符',
  'sync-conflict': '合并冲突'
};

const showArm = (row: DispenseRecord) => (row.status === 'voided' ? '—' : row.blindArm);
</script>

<template>
  <main class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP 盲底对账</el-tag>
        <h1>盲底 · 中心发号对账登记</h1>
        <p>导入按分层区组校验（断档 / 重号 / 名额配平，有错整份退回）；发号以盲底组别为准，本地不符即拦截留差异</p>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <el-input v-model="actor" style="width:160px" placeholder="操作人" />
        <el-switch v-model="offline" active-text="断网模式" inline-prompt />
        <el-button :type="offline ? 'success' : 'primary'" plain :disabled="offline && register.offlineQueue.length === 0" @click="syncNow">
          {{ offline ? '恢复网络·按序合并' : `模拟联网合并（待合并 ${register.offlineQueue.length}）` }}
        </el-button>
      </div>
    </header>

    <section class="stat-row">
      <div class="stat"><span>待入组</span><b>{{ stats.issued }}</b></div>
      <div class="stat"><span>已入组</span><b>{{ stats.enrolled }}</b></div>
      <div class="stat"><span>拦截差异（未结）</span><b :class="stats.openDiff ? 'danger-text' : ''">{{ stats.openDiff }}</b></div>
      <div class="stat"><span>作废重排待确认</span><b :class="stats.pendingReissue ? 'warn-text' : ''">{{ stats.pendingReissue }}</b></div>
      <div class="stat"><span>断网暂存</span><b :class="stats.offline ? 'warn-text' : ''">{{ stats.offline }}</b></div>
    </section>

    <el-card shadow="never" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          当前盲底：
          <el-tag v-if="blind" type="success" size="large">{{ blind.version }}</el-tag>
          <el-tag v-else type="danger" size="large">未导入</el-tag>
          <span v-if="blind" style="margin-left:10px;color:#607889">
            来源 {{ blind.source }} · {{ blind.rows.length }} 条编号 · 分层 {{ register.strata.join('、') }} · 导入人 {{ blind.importedBy }} · {{ new Date(blind.importedAt).toLocaleString() }}
          </span>
        </div>
        <el-tag v-if="offline" type="warning">断网中：发号只留本中心，恢复后按发号顺序合并，冲突两边都留</el-tag>
      </div>
    </el-card>

    <el-tabs v-model="tab" type="border-card">
      <!-- 盲底导入 -->
      <el-tab-pane label="盲底导入校验" name="blind">
        <div class="panel-grid">
          <el-card shadow="never">
            <template #header>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <b>统计组盲底随机表（CSV）</b>
                <div>
                  <el-button size="small" @click="loadSample('v1')">填入有效样例 v1</el-button>
                  <el-button size="small" @click="loadSample('v2')">填入更新版 v2</el-button>
                  <el-button size="small" type="danger" plain @click="loadSample('bad')">填入错误样例</el-button>
                </div>
              </div>
            </template>
            <el-form label-position="top">
              <div style="display:flex;gap:12px">
                <el-form-item label="版本号" style="flex:1"><el-input v-model="version" /></el-form-item>
                <el-form-item label="来源" style="flex:2"><el-input v-model="source" /></el-form-item>
              </div>
              <el-form-item label="盲底文件（列：stratum,block,sequence,arm）">
                <el-upload :auto-upload="false" :show-file-list="false" accept=".csv,text/csv" :on-change="onFile">
                  <el-button>选择 CSV 文件</el-button>
                </el-upload>
              </el-form-item>
              <el-input v-model="csvText" type="textarea" :rows="10" placeholder="stratum,block,sequence,arm&#10;18-44,1,1,A&#10;..." />
              <div style="margin-top:12px;display:flex;gap:10px">
                <el-button type="primary" @click="validateCsv">按分层/区组校验</el-button>
                <el-button type="success" :disabled="pendingRows.length === 0" @click="confirmImport">
                  {{ blind ? `确认更新为 ${version}` : `登记盲底 ${version}` }}
                </el-button>
              </div>
            </el-form>
          </el-card>

          <div>
            <el-alert v-if="importIssues.length > 0" type="error" :closable="false" style="margin-bottom:12px" title="校验未通过：整份退回，不登记任何编号">
              <ul style="margin:6px 0;padding-left:18px;max-height:220px;overflow:auto">
                <li v-for="(issue, index) in importIssues" :key="index">{{ issue.line > 0 ? `第${issue.line}行：` : '' }}{{ issue.message }}</li>
              </ul>
            </el-alert>
            <el-alert v-if="updatePreview" type="warning" :closable="false" style="margin-bottom:12px" title="更新影响预览（确认后才生效）">
              <div style="line-height:1.9">
                未变保留：<b>{{ updatePreview.kept }}</b> 条；发出未入组作废重排：<b class="warn-text">{{ updatePreview.voided }}</b> 条；
                已入组冻结告警：<b class="danger-text">{{ updatePreview.enrolledWarnings }}</b> 条（GCP 不予作废）
                <div v-if="updatePreview.reissues.length" style="margin-top:6px">
                  <el-tag v-for="(item, index) in updatePreview.reissues" :key="index" type="warning" size="small" style="margin:2px">
                    {{ item.stratum }}：{{ item.oldSequence }}({{ item.oldArm }}) → 重排（{{ item.reason }}）
                  </el-tag>
                </div>
              </div>
            </el-alert>
            <el-card shadow="never">
              <template #header><b>校验通过明细{{ pendingRows.length ? `（${pendingRows.length}）` : '' }}</b></template>
              <el-table :data="pendingRows" max-height="360" size="small">
                <el-table-column prop="stratum" label="分层" width="100" />
                <el-table-column prop="block" label="区组" width="80" />
                <el-table-column prop="sequence" label="编号" width="80" />
                <el-table-column prop="arm" label="组别" width="80">
                  <template #default="{ row }"><el-tag size="small">{{ row.arm }}</el-tag></template>
                </el-table-column>
              </el-table>
            </el-card>
          </div>
        </div>
      </el-tab-pane>

      <!-- 发号与台账 -->
      <el-tab-pane label="发号 · 统一登记台账" name="ledger">
        <div class="panel-grid">
          <el-card shadow="never">
            <template #header><b>中心发号</b><el-tag v-if="offline" type="warning" size="small" style="float:right">断网暂存</el-tag></template>
            <el-form label-position="top">
              <el-form-item label="本中心">
                <el-select v-model="site" style="width:100%">
                  <el-option label="上海中心" value="上海中心" />
                  <el-option label="广州中心" value="广州中心" />
                  <el-option label="新加坡中心" value="新加坡中心" />
                </el-select>
              </el-form-item>
              <el-form-item label="分层因素（年龄段）">
                <el-select v-model="stratum" style="width:100%" :placeholder="blind ? '选择分层' : '请先导入盲底'">
                  <el-option v-for="item in register.strata" :key="item" :label="item" :value="item" />
                </el-select>
              </el-form-item>
              <el-form-item label="受试者编号（发号时可留空，入组前补登）">
                <el-input v-model="participantNo" placeholder="如 S01-003" />
              </el-form-item>
              <el-form-item label="筛选号 / 脱敏身份键">
                <el-input v-model="subjectKey" placeholder="选填" />
              </el-form-item>
              <el-alert type="info" :closable="false" style="margin-bottom:10px"
                title="组别直接取盲底；本中心台账自行计算的组别若与盲底不一致，本次发号将被拦下并在差异表留档，编号不占用。" />
              <el-button type="primary" style="width:100%" :disabled="!blind" @click="issue">
                {{ offline ? '离线发号（暂存本中心）' : '按盲底发号' }}
              </el-button>
            </el-form>
          </el-card>

          <el-card shadow="never">
            <template #header>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <b>统一登记（盲底 × 中心台账）</b>
                <el-radio-group v-model="ledgerFilter" size="small">
                  <el-radio-button value="all">全部</el-radio-button>
                  <el-radio-button value="local">本中心</el-radio-button>
                  <el-radio-button value="issued">待入组</el-radio-button>
                  <el-radio-button value="enrolled">已入组</el-radio-button>
                  <el-radio-button value="blocked">拦截</el-radio-button>
                  <el-radio-button value="voided">作废</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="filteredRecords" max-height="480" size="small">
              <el-table-column prop="site" label="来源/中心" min-width="110">
                <template #default="{ row }">
                  <div>{{ row.site }}</div>
                  <el-tag size="small" :type="row.origin.startsWith('conflict') ? 'danger' : 'info'">{{ originLabel[row.origin] }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="stratum" label="分层" width="90" />
              <el-table-column prop="sequence" label="编号" width="70" />
              <el-table-column label="盲底组" width="75">
                <template #default="{ row }"><el-tag size="small" type="success">{{ showArm(row as DispenseRecord) }}</el-tag></template>
              </el-table-column>
              <el-table-column label="本地算" width="75">
                <template #default="{ row }"><el-tag size="small" :type="row.localArm === row.blindArm || row.status === 'voided' ? 'info' : 'danger'">{{ row.status === 'voided' ? '—' : row.localArm }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="participantNo" label="受试者" min-width="100" />
              <el-table-column label="状态" width="90">
                <template #default="{ row }"><el-tag size="small" :type="statusMeta[row.status].type">{{ statusMeta[row.status].label }}</el-tag></template>
              </el-table-column>
              <el-table-column label="版本/同步" width="110">
                <template #default="{ row }">
                  <div>{{ row.blindVersion }}</div>
                  <el-tag v-if="row.offline" size="small" type="warning">未同步</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button v-if="row.origin === 'local' && row.status === 'issued'" size="small" type="primary" @click="enroll(row as DispenseRecord)">入组</el-button>
                </template>
              </el-table-column>
              <template #empty><el-empty description="暂无发号记录" :image-size="60" /></template>
            </el-table>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- 差异 -->
      <el-tab-pane :label="`差异与拦截（${stats.openDiff}）`" name="diff">
        <el-card shadow="never">
          <template #header><b>差异留档（只追加，处置后仍可追溯）</b></template>
          <el-table :data="discrepancies" size="small">
            <el-table-column prop="at" label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.at).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="类型" width="120">
              <template #default="{ row }"><el-tag size="small" :type="row.type === 'sync-conflict' ? 'warning' : 'danger'">{{ diffTypeLabel[row.type] }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="stratum" label="分层" width="90" />
            <el-table-column prop="sequence" label="编号" width="70" />
            <el-table-column label="盲底/本地" width="90">
              <template #default="{ row }">
                <el-tag size="small" type="success">{{ row.blindArm }}</el-tag>
                /
                <el-tag size="small" type="danger">{{ row.localArm }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="detail" label="差异说明" min-width="280" />
            <el-table-column label="状态/处置" min-width="180">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'open' ? 'danger' : row.status === 'resolved' ? 'success' : 'info'">
                  {{ row.status === 'open' ? '待处置' : row.status === 'resolved' ? '已处置' : '已废弃' }}
                </el-tag>
                <div v-if="row.resolution" style="color:#607889;font-size:12px">{{ row.resolvedBy }}：{{ row.resolution }}</div>
                <el-button v-if="row.status === 'open'" size="small" type="warning" style="margin-top:4px" @click="resolveDiff(row as Discrepancy)">
                  {{ row.type === 'sync-conflict' ? '登记处置结论' : '授权放行（填原因）' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 作废重排 -->
      <el-tab-pane :label="`作废重排待确认（${stats.pendingReissue}）`" name="reissue">
        <el-card shadow="never">
          <template #header><b>盲底更新：发出未入组编号作废重排</b></template>
          <el-table :data="reissues" size="small">
            <el-table-column prop="createdAt" label="产生时间" width="170">
              <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column prop="stratum" label="分层" width="90" />
            <el-table-column label="旧编号" width="110">
              <template #default="{ row }">{{ row.oldSequence }}（{{ row.oldArm }}）已作废</template>
            </el-table-column>
            <el-table-column label="重排新编号" width="130">
              <template #default="{ row }">
                <el-tag v-if="row.newSequence" size="small" type="primary">{{ row.newSequence }}（{{ row.newArm }}）</el-tag>
                <el-tag v-else size="small" type="danger">待补盲底</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="作废原因" min-width="200" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'pending' ? 'warning' : row.status === 'confirmed' ? 'success' : 'info'">
                  {{ row.status === 'pending' ? '待确认' : row.status === 'confirmed' ? '已确认' : '已拒绝' }}
                </el-tag>
                <div v-if="row.confirmedBy" style="font-size:12px;color:#607889">{{ row.confirmedBy }}</div>
                <div v-if="row.note" style="font-size:12px;color:#c45656">{{ row.note }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <template v-if="row.status === 'pending'">
                  <el-button size="small" type="primary" :disabled="!row.reissuedId" @click="confirmReissue(row.id)">确认</el-button>
                  <el-button size="small" type="danger" plain :disabled="!row.reissuedId" @click="discardReissue(row.id)">拒绝</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 审计 -->
      <el-tab-pane label="操作日志" name="logs">
        <el-card shadow="never">
          <template #header><b>登记日志（只追加）</b></template>
          <el-timeline>
            <el-timeline-item v-for="entry in logs" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" placement="top">
              <b>{{ entry.actor }} · {{ entry.action }}</b>
              <div>{{ entry.detail }}</div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-if="logs.length === 0" description="暂无日志" />
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </main>
</template>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.danger-text { color: #c45656; }
.warn-text { color: #b88230; }
.panel-grid { display: grid; grid-template-columns: .9fr 1.1fr; gap: 18px; }
@media (max-width: 1000px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .panel-grid { grid-template-columns: 1fr; }
}
</style>

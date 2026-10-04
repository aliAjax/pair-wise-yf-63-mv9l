/** 示例盲底：统计组下发格式（CSV：code,stratum,block,arm） */

export function buildValidBlindCsv(): string {
  const strata = [
    { site: '上海中心', ageBand: '45-64' },
    { site: '广州中心', ageBand: '18-44' }
  ];
  const lines = ['code,stratum,block,arm'];
  let base = 2001;
  for (const { site, ageBand } of strata) {
    for (let b = 1; b <= 2; b++) {
      for (let i = 0; i < 4; i++) {
        // 每区组 2A2B，分层合计 4A4B
        const arm = i < 2 ? (b === 1 ? 'A' : 'B') : (b === 1 ? 'B' : 'A');
        lines.push(`${base++},${site}|${ageBand},${b},${arm}`);
      }
    }
  }
  return lines.join('\n');
}

/** 示例盲底（含错）：重号 2003、断档 2006、区组 2 名额不配平 */
export function buildBrokenBlindCsv(): string {
  return [
    'code,stratum,block,arm',
    '2001,上海中心|45-64,1,A',
    '2002,上海中心|45-64,1,B',
    '2003,上海中心|45-64,1,B',
    '2004,上海中心|45-64,1,A',
    '2003,上海中心|45-64,1,B', // 重号
    '2005,上海中心|45-64,2,B',
    // 2006 缺失 → 断档
    '2007,上海中心|45-64,2,B', // A 改成 B → 区组 2 配平不符 A=0 B=3
    '2008,上海中心|45-64,2,B',
    '2009,广州中心|18-44,1,A',
    '2010,广州中心|18-44,1,B',
    '2011,广州中心|18-44,1,B',
    '2012,广州中心|18-44,1,A',
    '2013,广州中心|18-44,2,B',
    '2014,广州中心|18-44,2,A',
    '2015,广州中心|18-44,2,A',
    '2016,广州中心|18-44,2,B'
  ].join('\n');
}

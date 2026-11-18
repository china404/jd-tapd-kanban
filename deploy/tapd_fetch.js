// TAPD MCP 取数脚本：带 429 退避重试
// 密钥优先级：环境变量 TAPD_KEY（GitHub Actions 用） > 本地 ~/.workbuddy/mcp.json
const fs = require('fs');
let KEY = process.env.TAPD_KEY || '';
if (!KEY) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const cfg = JSON.parse(fs.readFileSync(home + '/.workbuddy/mcp.json', 'utf8'));
    KEY = (cfg.mcpServers.tapd.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  } catch (e) {}
}
if (!KEY || KEY.includes('<SECRET>')) {
  console.error('缺少有效 TAPD 密钥：请设置环境变量 TAPD_KEY，或配置 ~/.workbuddy/mcp.json');
  process.exit(1);
}
const URL = 'https://i-agent-app.adapundi.com/proxy/tapd';
const WS = 44381896;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(name, args, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + KEY
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } })
    });
    const j = await res.json();
    const txt = j.result && j.result.content && j.result.content[0] && j.result.content[0].text;
    if (!txt) return { err: JSON.stringify(j) };
    let data;
    try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; }
    if (typeof data.error === 'string' && data.error.includes('429')) {
      console.error('  429 限流，退避重试 ' + (i + 1) + '/' + tries);
      await sleep(3000 * (i + 1));
      continue;
    }
    return data;
  }
  return { err: '429 retry exhausted' };
}

(async () => {
  const mode = process.argv[2] || 'probe';
  if (mode === 'probe') {
    const c = await call('tapd.count_stories', { workspace_id: WS, entity_type: 'stories', extra: { name: '【JD】' } });
    console.log('【JD】需求总数:', JSON.stringify(c));
    const c2 = await call('tapd.count_stories', { workspace_id: WS, entity_type: 'stories', extra: { name: 'JD' } });
    console.log('name含JD总数:', JSON.stringify(c2));
  } else if (mode === 'fetch') {
    const all = [];
    for (let page = 1; page <= 15; page++) {
      const r = await call('tapd.list_stories', {
        workspace_id: WS, entity_type: 'stories', page, limit: 50, extra: { name: '【JD】' }
      });
      if (r.err || r.status !== 1) { console.error('page ' + page + ' 失败:', JSON.stringify(r).slice(0, 300)); break; }
      const list = r.data || [];
      list.forEach(x => {
        const s = x.Story || x;
        all.push({
          id: s.id,
          short: s.id && s.id.length > 7 ? s.id.slice(-7) : s.id,
          name: s.name,
          type: s.workitem_type_id === '1144381896001000028' ? '需求'
              : s.workitem_type_id === '1144381896001000093' ? '任务'
              : s.workitem_type_id === '1144381896001000086' ? '特性'
              : s.workitem_type_id === '1144381896001000085' ? '史诗' : '其他',
          creator: s.creator,
          owner: (s.owner || '').replace(/;$/, ''),
          created: (s.created || '').slice(0, 10),
          status: s.status,
          priority: s.custom_field_five || '',
          requester: s.custom_field_one || '',
          line: s.custom_field_seven || '',
          taskType: s.custom_field_32 || '',
          pm: s.custom_field_six || '',
          begin: s.begin || '',
          due: s.due || '',
          progress: s.progress || '',
          effort: s.effort || '',
          effortDone: s.effort_completed || '',
          remain: s.remain || '',
          iteration: s.iteration_id || '',
          parent: s.parent_id || '',
          url: 'https://www.tapd.cn/' + WS + '/prong/stories/view/' + s.id
        });
      });
      console.log('page ' + page + ' 拿到 ' + list.length + ' 条, 累计 ' + all.length);
      if (list.length < 50) break;
      await sleep(1500);
    }
    require('fs').writeFileSync('jd-stories-clean.json', JSON.stringify(all, null, 2), 'utf8');
    console.log('已保存 jd-stories-clean.json, 共 ' + all.length + ' 条');
  } else if (mode === 'stats') {
    const all = JSON.parse(require('fs').readFileSync('jd-stories-clean.json', 'utf8'));
    const count = k => { const m = {}; all.forEach(x => { const v = x[k] || '(空)'; m[v] = (m[v] || 0) + 1; }); return m; };
    console.log('总数', all.length);
    console.log('类型', JSON.stringify(count('type')));
    console.log('状态', JSON.stringify(count('status')));
    console.log('提需方', JSON.stringify(count('requester')));
    console.log('优先级', JSON.stringify(count('priority')));
    console.log('业务条线', JSON.stringify(count('line')));
    console.log('任务类型', JSON.stringify(count('taskType')));
    const bs = all.map(x => x.begin).filter(Boolean).sort();
    const ds = all.map(x => x.due).filter(Boolean).sort();
    console.log('时间范围', bs[0], '~', ds[ds.length - 1]);
  } else if (mode === 'meta') {
    const sm = await call('tapd.get_status_map', { workspace_id: WS, system: 'story' });
    console.log('=== STATUS MAP ===\n' + JSON.stringify(sm).slice(0, 3000));
    await sleep(1200);
    const wt = await call('tapd.list_workitem_types', { workspace_id: WS });
    console.log('\n=== WORKITEM TYPES ===\n' + JSON.stringify(wt).slice(0, 3000));
    await sleep(1200);
    const cf = await call('tapd.list_custom_fields', { workspace_id: WS, entity_type: 'stories' });
    console.log('\n=== CUSTOM FIELDS ===\n' + JSON.stringify(cf).slice(0, 6000));
  } else if (mode === 'sample') {
    const r = await call('tapd.list_stories', {
      workspace_id: WS, entity_type: 'stories', page: 1, limit: 5, extra: { name: '【JD】' }
    });
    if (r.status === 1) {
      const list = r.data || [];
      console.log('返回 ' + list.length + ' 条');
      list.forEach((s, i) => console.log('\n--- 样本 ' + (i + 1) + ' ---\n' + JSON.stringify(s).slice(0, 3000)));
    } else console.log(JSON.stringify(r).slice(0, 1000));
  } else if (mode === 'fields') {
    const r = await call('tapd.list_custom_fields', { workspace_id: WS, entity_type: 'stories' });
    console.log(JSON.stringify(r).slice(0, 4000));
  } else if (mode === 'iters') {
    const r = await call('tapd.list_iterations', { workspace_id: WS, extra: { limit: 100 } });
    console.log(JSON.stringify(r).slice(0, 4000));
  }
})();

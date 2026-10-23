(() => {
  'use strict';
  const KEY='talkeval-shared-owner-keys-v1',LOCAL='talkeval-live-sessions-v1';
  const keys=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}');}catch{return {};}};
  const base=String(window.TalkEvalSharedConfig?.apiBase || '').replace(/\/$/,'');
  const configured=Boolean(base) || !location.hostname.endsWith('github.io');
  const ownerKey=(id,create=false)=>{const all=keys();if(!all[id]&&create){all[id]=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');localStorage.setItem(KEY,JSON.stringify(all));}return all[id] || '';};
  const url=path=>base+path;
  async function request(path,options={}) {
    if(!configured)throw Error('共享后台尚未接入。GitHub 页面只托管网页，当前记录仅在本机；请先配置团队共享服务。');
    const method=options.method || 'GET',headers=new Headers(options.headers || {}),match=path.match(/^\/api\/sessions\/([^/]+)/);
    if(match && ['PUT','DELETE'].includes(method))headers.set('X-Session-Key',ownerKey(decodeURIComponent(match[1]),method==='PUT'));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    try {
      const response=await fetch(url(path),{...options,headers,signal:controller.signal,credentials:'omit',cache:'no-store',mode:'cors'});
      if(!response.ok){let reason=`共享服务返回 ${response.status}`;try{reason=(await response.json()).error || reason;}catch{}const error=Error(reason);error.status=response.status;throw error;}
      return response;
    } catch(error){if(error.name==='AbortError')throw Error('共享同步超时，本机记录已保留，可重试。');if(error instanceof TypeError)throw Error('无法连接共享服务；本机保存尚未变成跨账号共享。');throw error;}
    finally{clearTimeout(timer);}
  }
  function publish(sessions,status={}) {window.dispatchEvent(new CustomEvent('talkeval:sessions',{detail:{sessions,status}}));}
  let bridge=null;
  function bind(value){bridge=value;window.dispatchEvent(new Event('talkeval:sessions-ready'));}
  const caseId=id=>'recording_'+id;
  function savedVisuals(session){
    const names=session.visualSampling?.coefficient_names || [];
    return (session.visual || []).map(sample=>({...sample,face:{...sample.face,blendshape_scores:sample.face?.blendshape_scores || Object.fromEntries(names.map((name,i)=>[name,sample.face?.blendshape_values?.[i]]).filter(([,value])=>Number.isFinite(value)))}}));
  }
  function assets(session){return {points:(session.points||[]).length,transcript:(session.segments||[]).length,audio:(session.audio||[]).length,visual:(session.visual||[]).length,timeline:(session.timeline||[]).length,slides:(session.slides||[]).length,contextFits:(session.contextFits||[]).length,report:Boolean(session.report),plan:Boolean(session.monitorF8?.plan?.length),video:Boolean(session.cloudVideoReady || session.videoSaved)};}
  function summary(session) {const points=session.points || [],located=points.filter(p=>p.evidence?.some(e=>session.segments?.some(s=>s.text===e.text))).length;return {case_id:caseId(session.id),title:session.topic || '现场演讲',speaker_id:session.speakerId,script_source:'saved_live_session',sessionId:session.id,shared:Boolean(session.cloudStored),videoReady:Boolean(session.cloudVideoReady || session.videoSaved),verdict_counts:{partially_realized:located,not_realized:points.length-located}};}
  async function loadCase(id) {
    if(!bridge)throw Error('现场记录尚未准备好');
    const session=bridge.sessions().find(s=>caseId(s.id)===id);
    if(!session)throw Error('该现场记录已删除或暂未同步到此设备');
    let videoUrl='',objectUrl=false;
    if(session.cloudStored && session.cloudVideoReady)videoUrl=url(`/api/sessions/${encodeURIComponent(session.id)}/video`);
    else if(session.videoSaved){const blob=await bridge.recording(session);if(blob){videoUrl=URL.createObjectURL(blob);objectUrl=true;}}
    const duration=Math.max(1,(session.endedAt-session.startedAt)/1000);
    const data=TalkEvalLaunch.liveData({session,points:session.points || [],analysisAudio:session.audio || [],visualWindow:savedVisuals(session)},duration);
    data.case_id=id;data.intent_map.title=session.topic;data.intent_map.language=session.language || session.monitorF8?.language || 'zh';
    data.intent_map.review_status='provisional';data.review_status='provisional';data.video_url=videoUrl;data.video_format='webm';
    data.metadata={topic:session.topic,speaker_id:session.speakerId,script_source:'saved_live_session',can_evaluate_original_intent:true,permission_verified:true,permission_evidence:'演讲者选择保存并共享'};
    data.run_metadata={asr_backend:'现场转写（含手动补充）',semantic_backend:'文字匹配参考'};
    data.saved_report=session.report || '本场未保存报告正文。';
    data.saved_monitor=session.monitorF8 || null;
    data.saved_session={id:session.id,assets:assets(session),expressionGoal:session.expressionGoal || '',timeline:session.timeline || [],slides:session.slides || [],contextFits:session.contextFits || [],fastReminders:session.monitorF8?.fastReminders || []};
    data.alignment={decisions:data.intent_map.beats.map(b=>{const point=session.points.find(p=>p.id===b.beat_id),ids=(point?.evidence || []).map(e=>data.expression_map.units.find(u=>u.text===e.text)?.observed_id).filter(Boolean),units=data.expression_map.units.filter(u=>ids.includes(u.observed_id));return {beat_id:b.beat_id,verdict:ids.length?'partially_realized':'not_realized',actual_time_span:units.length?[Math.min(...units.map(u=>u.time_span[0])),Math.max(...units.map(u=>u.time_span[1]))]:null,matched_observed_ids:ids,evidence_ids:ids,reason:'现场保存的提纲与转写线索，完整含义请结合录像复核。'};})};
    return {data,objectUrl,session};
  }
  window.TalkEvalShared={url,request,ownerKey,canManage:id=>Boolean(ownerKey(id)),bind,publish,summary,loadCase,caseId,assets,savedVisuals,
    rehearse:id=>bridge?.rehearse(id),
    sessions:()=>bridge?.sessions() || [],refresh:()=>bridge?.refresh(),open:id=>{document.querySelector('#review-tab').click();window.TalkEvalReplay?.selectCase(caseId(id));}};
})();

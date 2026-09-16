(function(root){
  'use strict';
  const M = {};
  M.key = (day, slot) => JSON.stringify([day, slot]);
  M.matches = (s, day, slot) => s.events.filter(e => e.type === 'med' && e.day === day && e.slot === slot);
  M.groups = s => [...new Set(s.schedule.map(m => m.time))].sort().map(time => ({time, items:s.schedule.filter(m => m.time === time)}));
  M.audit = (s, before, after, at, action='correct') => {
    (s.medicationHistory ||= []).push({id:root.P1.id(), eventId:before.id, action, recordedAt:at, before:structuredClone(before), after:after?structuredClone(after):null});
  };
  M.apply = (state, command, at = new Date().toISOString()) => {
    const s = structuredClone(state);
    for (const item of command.items) {
      const slot = item.slot || '';
      let old;
      if (command.mode === 'correct') {
        old = s.events.find(e => e.id === item.id && e.type === 'med');
        if (!old || JSON.stringify(old) !== JSON.stringify(item.expected)) throw Error('기록이 다른 화면에서 변경되었습니다. 다시 열어 확인하세요.');
      } else if (slot) {
        const found = M.matches(s, command.day, slot);
        if (found.length > 1) throw Error('같은 예정 복용 건에 여러 기록이 있습니다. 오늘 기록에서 각각 확인하세요. 자동 병합하지 않습니다.');
        // Repeated confirmations never turn into implicit corrections.
        if (found.length) continue;
      } else if (s.events.some(e => e.id === item.id)) continue;
      const minute = root.P1.toMinute(item.time);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) || !Number.isFinite(item.dose) || item.dose <= 0 || item.dose > 2000 || !item.name) throw Error('실제 시각과 약명·용량을 확인하세요.');
      const day = old ? old.day : command.day;
      const now = new Date(at);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > root.P1.day(now) || (day === root.P1.day(now) && minute > root.P1.minute(now))) throw Error('실제로 지난 날짜·시각만 기록할 수 있습니다.');
      const effectiveSlot = old ? old.slot || '' : slot;
      if (old && old.minute === minute && old.name === item.name && old.dose === item.dose && (old.note || '') === (item.note || '')) continue;
      const rec = {...(old || {}), id:old?.id || item.id, type:'med', day, minute, name:item.name, dose:item.dose, slot:effectiveSlot, note:item.note || '',
        createdAt:old?.createdAt || at, confirmedAt:old?.confirmedAt || old?.createdAt || at, updatedAt:at,
        occurrenceKey:effectiveSlot ? M.key(day, effectiveSlot) : (old?.occurrenceKey || item.id),
        scheduledTime:old?.scheduledTime || s.schedule.find(m => m.id === effectiveSlot)?.time || null};
      if (old) { M.audit(s, old, rec, at); s.events[s.events.findIndex(e => e.id === old.id)] = rec; }
      else s.events.push(rec);
    }
    return root.P1.validate(s);
  };
  const validate = root.P1.validate;
  root.P1.validate = s => {
    validate(s);
    if (s.medicationHistory !== undefined) {
      if (!Array.isArray(s.medicationHistory)) throw Error('복약 수정 이력이 잘못되었습니다.');
      for (const h of s.medicationHistory) {
        if (!h || typeof h.id !== 'string' || !['correct','delete'].includes(h.action) || !Number.isFinite(Date.parse(h.recordedAt)) || h.before?.type !== 'med' || h.before.id !== h.eventId || (h.after !== null && (h.after?.id !== h.eventId || h.after.type !== 'med'))) throw Error('복약 수정 이력이 잘못되었습니다.');
        validate({...s, events:[h.before, ...(h.after ? [{...h.after, id:h.after.id+'-validation'}] : [])]});
      }
    }
    return s;
  };
  root.P1Medication = M;
})(globalThis);

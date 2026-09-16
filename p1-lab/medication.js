(function(root){
  'use strict';
  const M = {};
  M.key = (day, slot) => JSON.stringify([day, slot]);
  // Read-only compatibility with pre-1.1 records: never guess a nearby time.
  M.slot = (s, e) => {
    if (!e || e.type !== 'med') return '';
    if (e.slot) return e.slot;
    if (e.entryKind === 'extra') return '';
    const keyed = s.schedule.filter(m => e.occurrenceKey === M.key(e.day, m.id));
    if (keyed.length === 1) return keyed[0].id;
    const exact = s.schedule.filter(m => m.name === e.name && m.dose === e.dose && root.P1.toMinute(m.time) === e.minute);
    return exact.length === 1 ? exact[0].id : '';
  };
  M.matches = (s, day, slot) => !slot ? [] : s.events.filter(e => e.type === 'med' && e.day === day && M.slot(s, e) === slot);
  M.sameDose = (a, b) => a.type === 'med' && a.day === b.day && a.minute === b.minute && a.name === b.name && a.dose === b.dose;
  M.groups = s => [...new Set(s.schedule.map(m => m.time))].sort().map(time => ({time, items:s.schedule.filter(m => m.time === time)}));
  M.audit = (s, before, after, at, action='correct') => {
    (s.medicationHistory ||= []).push({id:root.P1.id(), eventId:before.id, action, recordedAt:at, before:structuredClone(before), after:after?structuredClone(after):null});
  };
  M.apply = (state, command, at = new Date().toISOString()) => {
    if (!command || !['confirm','correct','extra'].includes(command.mode) || !Array.isArray(command.items) || !command.items.length) throw Error('복약 저장 요청을 확인하세요.');
    const s = structuredClone(state), now = new Date(at);
    if (!Number.isFinite(now.getTime())) throw Error('저장 시각을 확인하세요.');
    for (const item of command.items) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) || !Number.isFinite(item.dose) || item.dose <= 0 || item.dose > 2000 || typeof item.name !== 'string' || !item.name.trim()) throw Error('실제 시각과 약명·용량을 확인하세요.');
      const slot = item.slot || '', minute = root.P1.toMinute(item.time);
      let old;
      if (command.mode === 'correct') {
        old = s.events.find(e => e.id === item.id && e.type === 'med');
        if (!old || JSON.stringify(old) !== JSON.stringify(item.expected)) throw Error('기록이 다른 화면에서 변경되었습니다. 다시 열어 확인하세요.');
      } else if (s.events.some(e => e.id === item.id)) {
        // Only an identical retried request is a no-op; reject ID collisions.
        const existing = s.events.find(e => e.id === item.id);
        if (M.sameDose(existing, {day:command.day, minute, name:item.name, dose:item.dose}) && (existing.note || '') === (item.note || '') && (existing.slot || '') === slot) continue;
        throw Error('같은 기록 번호의 내용이 다릅니다. 다시 열어 확인하세요.');
      }
      const day = old ? old.day : command.day;
      const parsedDay = new Date(day + 'T12:00:00');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsedDay.getTime()) || root.P1.day(parsedDay) !== day || day > root.P1.day(now) || (day === root.P1.day(now) && minute > root.P1.minute(now))) throw Error('실제로 지난 날짜·시각만 기록할 수 있습니다.');
      // A correction preserves the occurrence even when actual time changes.
      const effectiveSlot = old ? M.slot(s, old) : slot;
      if (!old && slot && !s.schedule.some(m => m.id === slot)) throw Error('현재 예정표에 없는 복약 회차입니다. 다시 열어 주세요.');
      if (command.mode === 'extra' && slot) throw Error('별도 복용은 예정 복약과 분리해 기록하세요.');
      if (!old && slot) {
        const found = M.matches(s, day, slot);
        if (found.length > 1) throw Error('같은 예정 복용 건에 여러 기록이 있습니다. 기존 자료는 보존했습니다. 기록 수정에서 확인하세요.');
        if (found.length) continue;
      }
      const unchanged = old && old.minute === minute && old.name === item.name && old.dose === item.dose && (old.note || '') === (item.note || '');
      const same = s.events.filter(e => e.id !== old?.id && M.sameDose(e, {day, minute, name:item.name, dose:item.dose}));
      const distinct = command.mode === 'extra' && item.confirmedDistinct === true;
      // Exact duplicate guard also covers unassigned legacy records and new UUIDs.
      if (!unchanged && same.length && !distinct) throw Error('같은 날짜·시각·약·용량의 복약 기록이 이미 있습니다. 시각 변경은 기록 수정을 이용하세요. 실제로 추가 복용했다면 별도 복용 확인을 선택하세요.');
      if (unchanged && (old.slot || '') === effectiveSlot) continue;
      const rec = {...(old || {}), id:old?.id || item.id, type:'med', day, minute, name:item.name, dose:item.dose, slot:effectiveSlot, note:item.note || '',
        createdAt:old?.createdAt || at, confirmedAt:old?.confirmedAt || old?.createdAt || at, updatedAt:at,
        occurrenceKey:effectiveSlot ? M.key(day, effectiveSlot) : (old?.occurrenceKey || item.id),
        scheduledTime:old?.scheduledTime || s.schedule.find(m => m.id === effectiveSlot)?.time || null};
      if (command.mode === 'extra') rec.entryKind = 'extra';
      if (distinct) rec.distinctConfirmedAt = at;
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

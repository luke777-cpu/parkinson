/* P1 v1.1.1: guard UI retries without deleting or synthesizing observations. */
(function () {
  'use strict';
  const previousCommit = commitEvent;
  commitEvent = function (event) {
    if (event.type === 'output') {
      const sameTime = state.events.filter(e => e.type === 'output' && e.day === event.day && e.minute === event.minute && e.id !== event.id);
      if (sameTime.length) {
        const same = sameTime.some(e => e.value === event.value && (e.note || '') === (event.note || ''));
        toast(same ? '이미 저장된 출력입니다. 한 건만 유지했습니다.' : '이 시각의 출력 기록이 이미 있습니다. 오늘 기록의 수정을 이용하거나 실제 시각을 확인하세요.');
        return false;
      }
    }
    if (event.type === 'med') {
      const slot = P1Medication.slot(state, event);
      const found = slot ? P1Medication.matches(state, event.day, slot) : [];
      if (found.some(e => e.id !== event.id)) {
        toast('같은 예정 복약이 이미 있습니다. 새 기록을 추가하지 않았습니다.');
        return false;
      }
      if (!event.distinctConfirmedAt && state.events.some(e => e.id !== event.id && P1Medication.sameDose(e, event))) {
        toast('같은 복약 기록이 이미 있습니다. 기록 수정을 이용하세요.');
        return false;
      }
    }
    return previousCommit(event);
  };

  const label = document.createElement('label');
  label.id = 'distinctDoseLabel';
  label.hidden = true;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'distinctDose';
  label.append(checkbox, ' 같은 시각·같은 약의 기존 기록과 별개로 실제 추가 복용했습니다.');
  $('medFields').append(label);
  const previousEditor = openEditor;
  openEditor = function (type, event = null, slot = null, factor = null) {
    checkbox.checked = false;
    label.hidden = type !== 'med' || !!event;
    previousEditor(type, event, slot, factor);
  };

  const previousPersist = persistMedication;
  persistMedication = async function (commands) {
    if (medicationBusy) return false;
    const request = structuredClone(commands);
    for (const command of request) {
      // No-slot entry from the explicitly separate "별도 약 추가" editor.
      if (command.mode === 'confirm' && command.items.every(item => !item.slot)) {
        command.mode = 'extra';
        for (const item of command.items) item.confirmedDistinct = checkbox.checked;
      }
    }
    const buttons = [...document.querySelectorAll('#eventForm button[type="submit"], #groupForm button[type="submit"]')];
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    try { return await previousPersist(request); }
    finally { buttons.forEach((button, i) => { button.disabled = disabled[i]; }); }
  };

  // Count stored events, not the two UI views of the same medication event.
  const status = document.createElement('p');
  status.id = 'recordCount';
  status.className = 'muted';
  status.setAttribute('aria-live', 'polite');
  $('meds').before(status);
  const previousRenderMeds = renderMeds;
  renderMeds = function () {
    previousRenderMeds();
    const medications = dayEvents().filter(e => e.type === 'med');
    status.textContent = '이 날짜에 저장된 복약 ' + medications.length + '건 · 아래 시간순 목록과 같은 기록입니다.';
  };
  document.querySelectorAll('header small, footer').forEach(e => { e.textContent = e.textContent.replace(/v1\.1\.0/g, 'v1.1.1'); });
  renderMeds();
})();

// A private edit draft: no change reaches the task until the parent form saves.
export class StepEditor {
  constructor({ list, input, addButton, count, status, dialog, error, isBusy, icon, helpId = 'step-drag-help' }) {
    Object.assign(this, { list, input, addButton, count, status, dialog, error, isBusy, icon, helpId });
    this.steps = [];
    this.drag = null;
    this.frame = null;
    addButton.addEventListener('click', () => this.add());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.add(); }
    });
    list.addEventListener('pointerdown', (event) => this.startDrag(event));
    list.addEventListener('pointermove', (event) => this.moveDrag(event));
    list.addEventListener('pointerup', (event) => {
      if (this.drag?.pointerId === event.pointerId) this.finishDrag();
    });
    list.addEventListener('pointercancel', () => this.finishDrag(true));
    list.addEventListener('lostpointercapture', () => this.finishDrag(true));
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.drag) {
        event.preventDefault(); event.stopPropagation(); this.finishDrag(true);
      }
    });
  }

  reset(steps = []) {
    this.finishDrag(true);
    this.steps = steps.map((step) => ({ ...step, completionHistory: step.completionHistory.map((event) => ({ ...event })) }));
    this.input.value = '';
    this.status.textContent = '';
    this.render();
  }

  add() {
    if (this.isBusy() || this.drag) return;
    const title = this.input.value.trim();
    if (!title) { this.input.focus(); return; }
    if (this.steps.length >= 100) { this.error.textContent = 'У задачі може бути не більше 100 етапів.'; return; }
    this.steps.push({ id: crypto.randomUUID(), title, done: false, completedAt: null, completionHistory: [] });
    this.input.value = '';
    this.error.textContent = '';
    this.render();
    this.input.focus();
  }

  collect() {
    this.finishDrag();
    // Saving also includes a typed new step that has not yet had its + tapped.
    const pending = this.input.value.trim();
    const steps = this.steps.map((step) => ({ ...step, title: step.title.trim(), completionHistory: step.completionHistory.map((event) => ({ ...event })) }));
    if (pending) steps.push({ id: crypto.randomUUID(), title: pending, done: false, completedAt: null, completionHistory: [] });
    if (steps.length > 100) throw new Error('У задачі може бути не більше 100 етапів.');
    if (steps.some((step) => !step.title)) throw new Error('Заповни текст кожного етапу або видали порожній етап.');
    return steps;
  }

  render() {
    this.list.replaceChildren();
    for (const step of this.steps) {
      const row = document.createElement('li');
      row.dataset.stepId = step.id;
      row.className = 'step-edit-row';
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'step-drag-handle';
      handle.setAttribute('aria-describedby', this.helpId);
      handle.append(this.icon('grip'));
      handle.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (this.isBusy() || this.drag) return;
        const index = this.steps.findIndex((item) => item.id === step.id);
        const next = index + (event.key === 'ArrowUp' ? -1 : 1);
        if (next < 0 || next >= this.steps.length) return;
        const sibling = this.list.children[next];
        this.list.insertBefore(row, next < index ? sibling : sibling.nextSibling);
        this.syncOrder();
        handle.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
        this.announce(step.id);
      });
      const number = document.createElement('span');
      number.className = 'step-number';
      number.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control step-title-input';
      input.maxLength = 500;
      input.required = true;
      input.autocomplete = 'off';
      input.value = step.title;
      input.addEventListener('input', () => { step.title = input.value; });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.input.focus(); }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'step-remove-button';
      remove.dataset.stepAction = 'delete';
      remove.append(this.icon('trash'));
      remove.addEventListener('click', () => {
        if (this.isBusy() || this.drag) return;
        this.steps = this.steps.filter((item) => item.id !== step.id);
        this.render();
        this.input.focus({ preventScroll: true });
      });
      row.append(handle, number, input, remove);
      this.list.append(row);
    }
    this.updateLabels();
  }

  updateLabels() {
    this.count.textContent = `${this.steps.length} / 100`;
    [...this.list.children].forEach((row, index) => {
      row.querySelector('.step-number').textContent = String(index + 1).padStart(2, '0');
      row.querySelector('.step-title-input').setAttribute('aria-label', `Текст етапу ${index + 1}`);
      row.querySelector('.step-drag-handle').setAttribute('aria-label', `Перемістити етап ${index + 1}`);
      row.querySelector('.step-remove-button').setAttribute('aria-label', `Видалити етап ${index + 1}`);
    });
  }

  syncOrder() {
    const byId = new Map(this.steps.map((step) => [step.id, step]));
    this.steps = [...this.list.children].map((row) => byId.get(row.dataset.stepId));
    this.updateLabels();
  }

  announce(id) {
    const position = this.steps.findIndex((step) => step.id === id) + 1;
    this.status.textContent = `Етап переміщено на позицію ${position} з ${this.steps.length}.`;
  }

  startDrag(event) {
    const handle = event.target.closest('.step-drag-handle');
    if (!handle || this.isBusy() || this.drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    const row = handle.closest('[data-step-id]');
    this.drag = { pointerId: event.pointerId, row, startY: event.clientY, y: event.clientY, moved: false, original: [...this.steps] };
    // Capture on the stable list, because the row itself moves in the DOM.
    this.list.setPointerCapture(event.pointerId);
  }

  moveDrag(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.drag.y = event.clientY;
    if (!this.drag.moved && Math.abs(event.clientY - this.drag.startY) < 6) return;
    this.drag.moved = true;
    this.drag.row.classList.add('is-dragging');
    this.reorderAtPointer();
    if (!this.frame) this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  reorderAtPointer() {
    if (!this.drag) return;
    const candidates = [...this.list.children].filter((row) => row !== this.drag.row);
    const before = candidates.find((row) => {
      const rect = row.getBoundingClientRect();
      return this.drag.y < rect.top + rect.height / 2;
    });
    if (this.drag.row.nextElementSibling !== (before || null)) {
      this.list.insertBefore(this.drag.row, before || null);
      this.syncOrder();
    }
  }

  autoScroll() {
    this.frame = null;
    if (!this.drag?.moved) return;
    const rect = this.dialog.getBoundingClientRect();
    const distance = this.drag.y < rect.top + 64 ? -9 : this.drag.y > rect.bottom - 64 ? 9 : 0;
    if (distance) { this.dialog.scrollTop += distance; this.reorderAtPointer(); }
    this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  finishDrag(cancel = false) {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.row.classList.remove('is-dragging');
    if (cancel) {
      this.steps = drag.original;
      const rows = new Map([...this.list.children].map((row) => [row.dataset.stepId, row]));
      this.steps.forEach((step) => this.list.append(rows.get(step.id)));
      this.updateLabels();
    } else if (drag.moved) this.announce(drag.row.dataset.stepId);
    if (this.list.hasPointerCapture(drag.pointerId)) this.list.releasePointerCapture(drag.pointerId);
    drag.row.querySelector('.step-drag-handle')?.focus({ preventScroll: true });
  }
}

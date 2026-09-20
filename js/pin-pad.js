// One shared keypad per form. PIN values stay only in masked, readonly fields.
export class PinPad {
  constructor(form) {
    this.form = form;
    this.inputs = [...form.querySelectorAll('.pin-input')];
    this.mount = form.querySelector('[data-pin-pad]');
    this.settings = new Map();
    this.active = this.inputs[0];
    this.mount.classList.add('pin-pad');
    this.mount.setAttribute('role', 'group');
    this.mount.setAttribute('aria-label', 'Цифрова клавіатура PIN');
    for (const value of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'delete']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pin-key';
      if (/^\d$/.test(value)) {
        button.dataset.pinDigit = value;
        button.textContent = value;
        button.addEventListener('click', () => this.append(value));
      } else {
        button.classList.add('pin-key-action');
        button.dataset.pinAction = value;
        button.textContent = value === 'clear' ? 'Очистити' : '⌫';
        button.setAttribute('aria-label', value === 'clear' ? 'Очистити PIN' : 'Видалити останню цифру');
        button.addEventListener('click', () => this.erase(value === 'clear'));
      }
      this.mount.append(button);
    }
    this.status = document.createElement('p');
    this.status.className = 'pin-status';
    this.status.id = `${form.id}-pin-status`;
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.mount.after(this.status);
    for (const input of this.inputs) {
      input.readOnly = true;
      input.inputMode = 'none';
      input.autocomplete = 'off';
      input.setAttribute('aria-describedby', this.status.id);
      this.configure(input.id, { length: 4 });
      input.addEventListener('focus', () => this.select(input));
    }
    form.addEventListener('keydown', (event) => {
      if (!this.isPadTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (/^\d$/.test(event.key)) { event.preventDefault(); this.append(event.key); }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault(); this.erase(event.key === 'Delete');
      }
    });
    form.addEventListener('paste', (event) => {
      if (!this.isPadTarget(event.target) || !this.canEdit()) return;
      event.preventDefault();
      const value = event.clipboardData?.getData('text') || '';
      const maximum = this.settings.get(this.active).length || 12;
      if (!/^\d+$/.test(value) || value.length > maximum) {
        this.error('Встав лише цифри PIN без пробілів. Код не було змінено.');
        return;
      }
      this.active.value = value;
      this.changed();
    });
    // Readonly controls do not participate in the browser's required/pattern
    // checks. Validate them before the app's submit handler can run.
    form.addEventListener('submit', (event) => {
      const invalid = this.inputs.find((input) => input.required && !input.disabled && !this.valid(input));
      if (!invalid) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const length = this.settings.get(invalid).length;
      this.error(length ? `PIN має містити рівно ${length} цифр.` : 'Введи PIN із 4 цифр або старий PIN із 6–12 цифр.');
      invalid.focus();
    }, true);
    form.addEventListener('reset', () => this.reset());
    this.reset();
  }

  configure(id, { length = null } = {}) {
    const input = this.inputs.find((item) => item.id === id);
    if (!input) throw new Error('Невідоме поле PIN.');
    const known = Number.isInteger(length) && (length === 4 || length >= 6 && length <= 12) ? length : null;
    this.settings.set(input, { length: known });
    input.maxLength = known || 12;
    input.minLength = known || 4;
    input.pattern = known ? `[0-9]{${known}}` : '(?:[0-9]{4}|[0-9]{6,12})';
    input.placeholder = known ? '•'.repeat(known) : 'Твій попередній PIN';
    this.render();
  }

  valid(input) {
    const length = this.settings.get(input).length;
    return length ? new RegExp(`^\\d{${length}}$`).test(input.value) : /^(?:\d{4}|\d{6,12})$/.test(input.value);
  }

  isPadTarget(target) { return this.inputs.includes(target) || this.mount.contains(target); }
  canEdit() { return this.active && !this.active.disabled && this.active.getClientRects().length > 0; }

  select(input) { this.active = input; this.render(); }

  append(digit) {
    if (!this.canEdit()) return;
    // On iOS, tapping a button need not blur the name's editable text field.
    // Focus the readonly PIN explicitly so the native keyboard can dismiss.
    this.active.focus({ preventScroll: true });
    const maximum = this.settings.get(this.active).length || 12;
    if (this.active.value.length >= maximum) { this.error(`У цьому PIN максимум ${maximum} цифр.`); return; }
    this.active.value += digit;
    this.changed();
  }

  erase(all = false) {
    if (!this.canEdit()) return;
    this.active.focus({ preventScroll: true });
    this.active.value = all ? '' : this.active.value.slice(0, -1);
    this.changed(false);
  }

  changed(advance = true) {
    const input = this.active;
    this.form.querySelector('.form-error').textContent = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const next = this.inputs[this.inputs.indexOf(input) + 1];
    if (advance && this.settings.get(input).length && this.valid(input) && next && !next.disabled) {
      next.focus({ preventScroll: true });
    }
    this.render();
  }

  error(message) { this.form.querySelector('.form-error').textContent = message; }

  render() {
    if (!this.status || !this.active || !this.settings.has(this.active)) return;
    this.inputs.forEach((input) => input.classList.toggle('is-active', input === this.active));
    const label = this.active.labels?.[0]?.textContent || 'PIN';
    const length = this.settings.get(this.active).length;
    this.status.textContent = length
      ? `${label}: ${this.active.value.length} із ${length} цифр.`
      : `${label}: введено ${this.active.value.length} цифр. PIN із 4 або 6–12 цифр.`;
  }

  reset() {
    this.inputs.forEach((input) => { input.value = ''; });
    this.active = this.inputs[0];
    this.render();
  }
}

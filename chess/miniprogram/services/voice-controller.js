// Intent stays separate from native microphone state so a late join cannot reopen a released press.
class VoiceController {
  constructor(room, onChange, canConnect = () => true) {
    this.room = room;
    this.onChange = onChange;
    this.canConnect = canConnect;
    this.continuous = false;
    this.holding = false;
    this.touching = false;
    this.consumed = false;
    this.active = true;
    this.tasks = 0;
    this.error = '';
    this.generation = 0;
  }
  emit() {
    this.onChange({ continuous: this.continuous, holding: this.holding, pressed: this.touching,
      busy: this.tasks > 0, error: this.error });
  }
  wantsMicrophone() { return this.active && (this.continuous || this.holding); }
  async run(task) {
    this.tasks++;
    this.error = '';
    this.emit();
    try { await task(); return true; }
    catch (err) {
      this.continuous = false;
      this.holding = false;
      if (this.active) this.error = err.errMsg || err.message || '语音操作失败';
      try { await this.room.leave(); }
      catch (leaveError) { if (this.active) this.error += '；未能确认退出：' + (leaveError.errMsg || leaveError.message || '请重新进入棋桌'); }
      return false;
    } finally { this.tasks--; this.emit(); }
  }
  async apply() {
    if (!this.active) return;
    if (this.wantsMicrophone()) {
      if (!this.canConnect()) throw new Error('棋局连接尚未恢复，请连接成功后使用语音');
      await this.room.join();
    }
    // Always read the latest intent after authorization and native join have completed.
    if (this.wantsMicrophone() && !this.canConnect()) throw new Error('棋局连接已中断，语音已关闭');
    if (this.room.joined) await this.room.mute(this.wantsMicrophone(), this.room.earphone);
  }
  toggle() {
    if (!this.active) return Promise.resolve(false);
    this.continuous = !this.continuous;
    this.holding = false;
    return this.run(() => this.apply());
  }
  touchStart() {
    clearTimeout(this.pressTimer);
    this.touching = true;
    this.consumed = false;
    this.pressTimer = setTimeout(() => this.longPress(), 350);
    this.emit();
  }
  longPress() {
    clearTimeout(this.pressTimer);
    if (!this.touching || !this.active) return Promise.resolve(false);
    this.consumed = true;
    if (this.continuous || this.holding) return Promise.resolve(true);
    this.holding = true;
    return this.run(() => this.apply());
  }
  touchEnd() {
    clearTimeout(this.pressTimer);
    this.touching = false;
    if (!this.holding) { this.emit(); return Promise.resolve(true); }
    this.holding = false;
    // Dispatch the native mute immediately, even if an earlier unmute callback is pending.
    return this.run(() => this.apply());
  }
  touchCancel() {
    clearTimeout(this.pressTimer);
    this.consumed = true;
    this.touching = false;
    this.continuous = false;
    this.holding = false;
    return this.run(() => this.apply());
  }
  tap() {
    if (this.consumed) return Promise.resolve(false);
    return this.toggle();
  }
  toggleEarphone() {
    if (!this.active) return Promise.resolve(false);
    const generation = this.generation;
    return this.run(async () => {
      if (!this.canConnect()) throw new Error('棋局连接尚未恢复，请连接成功后收听');
      if (!this.room.joined) {
        await this.room.join({ silent: true });
        if (!this.active || generation !== this.generation) { await this.room.leave(); return; }
        if (!this.canConnect()) throw new Error('棋局连接已中断，语音已关闭');
        await this.room.mute(this.wantsMicrophone(), true);
      } else {
        await this.room.mute(this.wantsMicrophone(), !this.room.earphone);
      }
    });
  }
  roomChanged(state) {
    if (state.interrupted) {
      this.generation++;
      clearTimeout(this.pressTimer);
      this.continuous = false;
      this.holding = false;
      this.touching = false;
      this.consumed = true;
      this.error = state.error || '语音已中断，请重新开启';
      this.emit();
    }
  }
  resume() { this.active = true; this.emit(); }
  async stop(reason = '', inactive = false) {
    this.generation++;
    clearTimeout(this.pressTimer);
    this.active = !inactive;
    this.continuous = false;
    this.holding = false;
    this.touching = false;
    this.consumed = true;
    this.error = reason;
    this.emit();
    try { await this.room.leave(); }
    catch (err) { this.error = (reason ? reason + '；' : '') + (err.errMsg || err.message || '退出语音失败'); this.emit(); }
  }
}
module.exports = VoiceController;

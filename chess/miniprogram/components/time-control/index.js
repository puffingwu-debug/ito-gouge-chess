Component({
  properties: {
    value: { type: Object, value: {}, observer(value) { this.setData({ control: value }); } },
    disabled: { type: Boolean, value: false }
  },
  data: { control: {} },
  methods: {
    patch(field, value) {
      const control = Object.assign({}, this.data.control, { [field]: value });
      this.setData({ control });
      this.triggerEvent('change', { value: control });
    },
    mode(event) { this.patch('mode', event.currentTarget.dataset.mode); },
    unlimited(event) {
      const field = event.currentTarget.dataset.field;
      this.patch(field, event.detail.value ? null : (field === 'totalSeconds' ? 600 : 60));
    },
    number(event) {
      const field = event.currentTarget.dataset.field;
      const parsed = Number(event.detail.value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        wx.showToast({ title: '时长需大于 0', icon: 'none' });
        this.setData({ control: Object.assign({}, this.data.control) });
        return;
      }
      this.patch(field, Math.round(parsed * (field === 'totalSeconds' ? 60 : 1)));
    }
  }
});

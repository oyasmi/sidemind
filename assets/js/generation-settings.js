// ===== Shared generation settings and configuration migration =====
const GenerationSettings = (() => {
  const VERSION = 2;
  const DEFAULTS = { stream: true, temperature: null, max_completion_tokens: null, reasoning_effort: null, reasoning_summary: null, reasoning_context: null };
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const KEYS = Object.keys(DEFAULTS);

  function valid(parameters, partial = true) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    return Object.entries(parameters).every(([key, value]) => {
      if (!KEYS.includes(key)) return false;
      if (value === null) return key !== 'stream';
      if (key === 'stream') return typeof value === 'boolean';
      if (key === 'temperature') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2;
      if (key === 'max_completion_tokens') return Number.isSafeInteger(Number(value)) && /^[1-9]\d*$/.test(String(value));
      if (key === 'reasoning_effort') return EFFORTS.includes(value);
      if (key === 'reasoning_summary') return ['auto', 'concise', 'detailed'].includes(value);
      if (key === 'reasoning_context') return ['auto', 'current_turn', 'all_turns'].includes(value);
      return false;
    }) && (partial || KEYS.every((key) => key in parameters));
  }

  function migrate(input) {
    const config = structuredClone(input);
    if (config.generationVersion === VERSION) return config;
    const legacy = {};
    KEYS.forEach((key) => {
      if (!(key in config)) return;
      const value = config[key];
      legacy[key] = value === '' || value === 'off' ? null : value;
    });
    (config.providers || []).forEach((provider) => {
      provider.parameters = { ...legacy, ...provider.parameters };
      provider.reasoningFormat ||= provider.apiType === 'responses' ? 'structured' : 'think-tags';
    });
    KEYS.forEach((key) => { config[key] = DEFAULTS[key]; });
    config.generationVersion = VERSION;
    return config;
  }

  function resolve(config, provider, modelId) {
    const model = provider?.models?.find((item) => item.id === modelId);
    const result = { ...DEFAULTS };
    const origins = {};
    [config, provider?.parameters, model?.parameters].forEach((parameters, index) => {
      if (!parameters) return;
      KEYS.forEach((key) => {
        if (parameters[key] === undefined) return;
        const value = parameters[key];
        result[key] = value === '' || value === 'off' ? null : value;
        origins[key] = ['Default', provider?.name || 'Provider', model?.name || 'Model'][index];
      });
    });
    if (!valid(result, false)) throw new Error('Invalid generation parameters. Review the selected model in Settings.');
    return { values: result, origins };
  }

  function withLock(task) {
    return typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('sidemind-config', task) : task();
  }

  return { VERSION, DEFAULTS, EFFORTS, KEYS, valid, migrate, resolve, withLock };
})();

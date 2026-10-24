// ===== Responses protocol: no DOM, storage or network dependencies =====
const ResponsesProtocol = (() => {
  const runtimes = new WeakMap();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function apiError(error = {}, fallback = 'Response failed') {
    const result = new Error(`API Error: ${error.message || fallback}`);
    result.code = error.code || null;
    result.param = error.param || null;
    return result;
  }

  function record(message) {
    if (!message.protocol) {
      message.protocol = { version: 1, apiType: 'responses', output: [] };
    }
    return message.protocol;
  }

  function runtime(message) {
    if (!runtimes.has(message)) runtimes.set(message, { sequence: -1 });
    return runtimes.get(message);
  }

  function project(message) {
    const output = record(message).output;
    const answers = [];
    const thoughts = [];
    const unsupported = [];
    output.forEach((item) => {
      if (!item) return;
      if (item.type === 'message') {
        const text = (item.content || []).map((part) => {
          if (part?.type === 'output_text') return part.text || '';
          if (part?.type === 'refusal') return part.refusal || '';
          return '';
        }).join('');
        if (text) answers.push(text);
      } else if (item.type === 'reasoning') {
        [...(item.summary || []), ...(item.content || [])].forEach((part) => {
          if (part?.text) thoughts.push(part.text);
        });
      } else {
        unsupported.push(item.type || 'unknown');
      }
    });
    message.content = answers.join('\n\n');
    message.reasoning = thoughts.join('\n\n');
    message.unsupportedOutput = unsupported.length ? [...new Set(unsupported)] : null;
  }

  function itemFor(event, message, type = 'message') {
    const output = record(message).output;
    let index = event.output_index;
    if (!Number.isInteger(index) || index < 0) {
      index = event.item_id ? output.findIndex((item) => item?.id === event.item_id) : -1;
      if (index < 0) {
        index = output.findIndex((item) => item?.type === type);
        if (index < 0) index = output.length;
      }
    }
    if (index > 10000) throw apiError({}, 'Invalid output index');
    let item = output[index];
    if (item && event.item_id && item.id && item.id !== event.item_id) {
      throw apiError({}, 'Conflicting output item IDs');
    }
    if (!item) {
      item = { type, status: 'in_progress', ...(type === 'message' ? { role: 'assistant', content: [] } : { summary: [] }) };
      output[index] = item;
    }
    if (event.item_id) item.id = event.item_id;
    return { item, index };
  }

  function partFor(event, message, field, type) {
    const { item } = itemFor(event, message, field === 'summary' || type === 'reasoning_text' ? 'reasoning' : 'message');
    const key = field === 'summary' ? 'summary_index' : 'content_index';
    const index = Number.isInteger(event[key]) && event[key] >= 0 ? event[key] : 0;
    if (index > 10000) throw apiError({}, 'Invalid content index');
    item[field] ||= [];
    item[field][index] ||= { type, [type === 'refusal' ? 'refusal' : 'text']: '' };
    return { item, part: item[field][index], index };
  }

  function applyBody(data, message, expectedStatus) {
    if (!data || typeof data !== 'object' ||
        (!Array.isArray(data.output) && typeof data.output_text !== 'string' && !data.error && data.status !== 'failed')) {
      throw apiError({}, 'The provider returned no answer. Check the API type in Settings and retry.');
    }
    if (expectedStatus && data.status !== expectedStatus) {
      throw apiError({}, 'The provider returned an invalid response status.');
    }
    if (data.status && !['completed', 'incomplete', 'failed'].includes(data.status)) {
      throw apiError({}, `Unsupported response status: ${data.status}. Background responses are not supported.`);
    }
    const protocol = record(message);
    if (data.id) protocol.responseId = data.id;
    if (data.model) protocol.model = data.model;
    protocol.status = data.status || 'completed';
    // Full response snapshots are authoritative, including empty output.
    if (Array.isArray(data.output)) protocol.output = clone(data.output);
    else if (typeof data.output_text === 'string') {
      protocol.output = [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: data.output_text }] }];
    }
    if (data.usage) protocol.usage = clone(data.usage);
    project(message);
    if (data.error || data.status === 'failed') {
      message.outcome = 'failed';
      protocol.error = clone(data.error || {});
      throw apiError(data.error);
    }
    message.outcome = protocol.status;
    if (protocol.status === 'incomplete') message.incompleteReason = data.incomplete_details?.reason || 'unknown reason';
    else delete message.incompleteReason;
    delete message.completionUnconfirmed;
  }

  function applyEvent(event, message) {
    if (!event || typeof event !== 'object') throw apiError({}, 'Invalid streaming event');
    const current = runtime(message);
    if (Number.isInteger(event.sequence_number)) {
      if (event.sequence_number <= current.sequence) return false;
      current.sequence = event.sequence_number;
    }
    const protocol = record(message);
    if (event.error) {
      message.outcome = 'failed';
      throw apiError(event.error);
    }
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        if (event.response?.id) protocol.responseId = event.response.id;
        protocol.status = event.response?.status || 'in_progress';
        return false;
      case 'response.output_item.added':
      case 'response.output_item.done': {
        if (!event.item || typeof event.item.type !== 'string') return false;
        const { index } = itemFor({ ...event, item_id: event.item.id }, message, event.item.type);
        protocol.output[index] = clone(event.item);
        if (event.type.endsWith('.done')) protocol.output[index].status ||= 'completed';
        break;
      }
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done': {
        if (!event.part) return false;
        const field = event.type.includes('reasoning_summary') ? 'summary' : 'content';
        const { item, index } = partFor(event, message, field, event.part.type);
        item[field][index] = clone(event.part);
        break;
      }
      case 'response.output_text.delta':
      case 'response.output_text.done':
      case 'response.refusal.delta':
      case 'response.refusal.done':
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.delta':
      case 'response.reasoning_text.done': {
        const summary = event.type.includes('reasoning_summary');
        const type = summary ? 'summary_text' : event.type.includes('reasoning_text') ? 'reasoning_text' : event.type.includes('refusal') ? 'refusal' : 'output_text';
        const field = type === 'refusal' ? 'refusal' : 'text';
        const { part } = partFor(event, message, summary ? 'summary' : 'content', type);
        if (event.type.endsWith('.done')) {
          if (typeof event[field] === 'string') part[field] = event[field];
        } else if (typeof event.delta === 'string') part[field] = (part[field] || '') + event.delta;
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const status = event.type.slice('response.'.length);
        try {
          applyBody(event.response, message, status);
        } finally {
          if (message.outcome === status) {
            message.streamComplete = true;
            message.streamEnded = true;
          }
        }
        return true;
      }
      case 'error':
        message.outcome = 'failed';
        throw apiError(event);
      default:
        return false;
    }
    project(message);
    return true;
  }

  function sameSource(a, b) {
    return Boolean(a && b && ['providerId', 'baseUrl', 'modelId', 'instructions'].every((key) => a[key] === b[key]));
  }

  function replayItems(protocol) {
    return (protocol.output || []).flatMap((item) => {
      if (!item || item.status === 'in_progress' || item.status === 'incomplete') return [];
      if (item.type === 'reasoning') {
        if (!item.id || !item.encrypted_content) return [];
        return [{ type: 'reasoning', id: item.id, summary: clone(item.summary || []), encrypted_content: item.encrypted_content,
          ...(item.content ? { content: clone(item.content) } : {}), ...(item.status ? { status: item.status } : {}) }];
      }
      if (item.type === 'message' && item.role === 'assistant') {
        const content = (item.content || []).flatMap((part) => {
          if (part?.type === 'output_text' && typeof part.text === 'string') {
            return [{ type: 'output_text', text: part.text, annotations: clone(part.annotations || []), ...(part.logprobs ? { logprobs: clone(part.logprobs) } : {}) }];
          }
          if (part?.type === 'refusal' && typeof part.refusal === 'string') return [{ type: 'refusal', refusal: part.refusal }];
          return [];
        });
        if (!content.length) return [];
        const phase = ['commentary', 'final_answer'].includes(item.phase) ? { phase: item.phase } : {};
        // Output messages are themselves an input union member: id and status
        // belong to that wire shape. Only compatible servers may omit them.
        if (typeof item.id === 'string') return [{ type: 'message', id: item.id, role: 'assistant', status: 'completed', content, ...phase }];
        return [{ type: 'message', role: 'assistant', content: content.map((part) => part.text || part.refusal || '').join(''), ...phase }];
      }
      return [];
    });
  }

  function history(messages, source) {
    let boundary = -1;
    messages.forEach((message, index) => {
      if (message.role === 'assistant' && !sameSource(message.protocol?.source, source)) boundary = index;
    });
    return messages.flatMap((message, index) => {
      if (message.role === 'user') return [{ role: 'user', content: message.content || '', ...(message.attachments?.length ? { attachments: clone(message.attachments) } : {}) }];
      if (message.role !== 'assistant') return [];
      const completeItems = (message.protocol?.output || []).every((item) => item?.status === 'completed');
      if (index > boundary && message.reasoningFormat !== 'think-tags' && sameSource(message.protocol?.source, source) &&
          (message.outcome === 'completed' || completeItems) &&
          ['completed', 'incomplete'].includes(message.outcome) && !message.unsupportedOutput?.length) {
        const items = replayItems(message.protocol);
        if (items.length) return items;
      }
      return message.content?.trim() ? [{ role: 'assistant', content: message.content }] : [];
    });
  }

  return { applyEvent, applyBody, history, sameSource, project };
})();

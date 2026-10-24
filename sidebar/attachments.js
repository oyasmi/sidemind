// ===== Local attachment originals. Transcripts contain references only. =====
const AttachmentStore = (() => {
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
  const MAX_BODY_BYTES = 30 * 1024 * 1024;
  const MAX_COUNT = 10;
  const GRACE_MS = 24 * 60 * 60 * 1000;
  const TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    html: 'text/html', htm: 'text/html', xml: 'text/xml', csv: 'text/csv', tsv: 'text/tsv',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    js: 'text/javascript', ts: 'application/typescript', tsx: 'text/tsx', jsx: 'text/jsx', py: 'text/x-python',
    c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c', cs: 'text/x-csharp', java: 'text/x-java',
    go: 'text/x-golang', rs: 'text/x-rust', rb: 'text/x-ruby', php: 'text/x-php', sh: 'text/x-shellscript',
    css: 'text/css', sql: 'text/x-sql', yaml: 'text/x-yaml', yml: 'text/x-yaml', tex: 'text/x-tex'
  };
  let database;

  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('sidemind-attachments', 1);
      request.onupgradeneeded = () => {
        ['files', 'metadata', 'pins'].forEach((name) => request.result.createObjectStore(name, { keyPath: 'id' }));
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = null; };
        resolve(request.result);
      };
      request.onerror = () => { database = null; reject(request.error); };
      request.onblocked = () => { database = null; reject(new Error('Close other SideMind pages and retry opening attachments.')); };
    });
    return database;
  }

  async function transaction(stores, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('Could not save the attachment.'));
      tx.onabort = () => reject(tx.error || new Error('Attachment storage was interrupted.'));
      try { action(tx, (result) => { value = result; }); } catch (error) { tx.abort(); reject(error); }
    });
  }

  function staticGif(bytes) {
    if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))) return false;
    let offset = 13 + ((bytes[10] & 0x80) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
    let frames = 0;
    const skipBlocks = () => {
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (!length) return true;
        offset += length;
      }
      return false;
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) return frames === 1;
      if (marker === 0x21) { offset++; if (!skipBlocks()) return false; }
      else if (marker === 0x2c) {
        if (++frames > 1 || offset + 9 >= bytes.length) return false;
        const packed = bytes[offset + 8];
        offset += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0);
        offset++;
        if (!skipBlocks()) return false;
      } else return false;
    }
    return false;
  }

  async function validate(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const mime = TYPES[extension];
    if (!mime) throw new Error(`“${file.name}” is not a supported attachment type.`);
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}” must be non-empty and no larger than 10 MiB.`);
    const image = mime.startsWith('image/');
    const bytes = new Uint8Array(await file.slice(0, extension === 'gif' ? file.size : 1024).arrayBuffer());
    const signature = String.fromCharCode(...bytes.slice(0, 12));
    const validImage = extension === 'png' ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
      : ['jpg', 'jpeg'].includes(extension) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : extension === 'webp' ? signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
          : extension === 'gif' ? staticGif(bytes) : true;
    if ((image && !validImage) || (extension === 'pdf' && !new TextDecoder().decode(bytes).includes('%PDF-'))) {
      throw new Error(`“${file.name}” is invalid or unsupported. GIF images must be static.`);
    }
    if (file.type?.startsWith('image/') && file.type !== mime && !(file.type === 'image/jpg' && mime === 'image/jpeg')) {
      throw new Error(`“${file.name}” has a mismatched file type.`);
    }
    return { id: crypto.randomUUID(), name: file.name, mime, size: file.size, kind: image ? 'image' : 'file' };
  }

  async function put(file, ref, owner) {
    await transaction(['files', 'metadata', 'pins'], 'readwrite', (tx) => {
      tx.objectStore('files').put({ id: ref.id, blob: file.slice(0, file.size, ref.mime) });
      tx.objectStore('metadata').put({ ...ref, createdAt: Date.now() });
      // Keep publication safe while the chrome.storage reference is being saved.
      tx.objectStore('pins').put({ id: `${owner}:${ref.id}`, attachments: [ref.id], expires: Date.now() + GRACE_MS });
    });
  }

  async function get(ref) {
    const entry = await transaction(['files'], 'readonly', (tx, set) => {
      const request = tx.objectStore('files').get(ref.id);
      request.onsuccess = () => set(request.result);
    });
    if (!entry?.blob || entry.blob.size !== ref.size) throw new Error(`Attachment “${ref.name}” is missing. Edit the message to replace or remove it.`);
    return entry.blob;
  }

  async function pin(owner, refs, duration = GRACE_MS) {
    if (!refs.length) return;
    await transaction(['pins', 'metadata'], 'readwrite', (tx) => {
      tx.objectStore('pins').put({ id: owner, attachments: refs.map((ref) => ref.id), expires: Date.now() + duration });
      refs.forEach((ref) => {
        const request = tx.objectStore('metadata').get(ref.id);
        request.onsuccess = () => {
          if (request.result) { delete request.result.orphanedAt; tx.objectStore('metadata').put(request.result); }
        };
      });
    });
  }

  function references(value, result = new Set()) {
    if (!value || typeof value !== 'object') return result;
    if (Array.isArray(value.attachments)) value.attachments.forEach((ref) => { if (ref?.id) result.add(ref.id); });
    Object.entries(value).forEach(([key, child]) => { if (key !== 'attachments') references(child, result); });
    return result;
  }

  async function collect(referenced, now = Date.now()) {
    await transaction(['files', 'metadata', 'pins'], 'readwrite', (tx) => {
      const pins = tx.objectStore('pins').getAll();
      pins.onsuccess = () => {
        pins.result.forEach((entry) => {
          if (entry.expires > now) entry.attachments.forEach((id) => referenced.add(id));
          else tx.objectStore('pins').delete(entry.id);
        });
        const cursor = tx.objectStore('metadata').openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const value = entry.value;
          if (referenced.has(value.id)) {
            if (value.orphanedAt) { delete value.orphanedAt; entry.update(value); }
          } else if (!value.orphanedAt) entry.update({ ...value, orphanedAt: now });
          else if (now - value.orphanedAt >= GRACE_MS) {
            tx.objectStore('files').delete(value.id);
            entry.delete();
          }
          entry.continue();
        };
      };
    });
  }

  function assertSupported(refs, apiType) {
    refs.forEach((ref) => {
      if (apiType === 'chat' && ref.kind !== 'image' && ref.mime !== 'application/pdf') {
        throw new Error(`“${ref.name}” requires the Responses API. Choose a Responses provider, or edit the message to remove it.`);
      }
    });
  }

  async function hydrate(body, key, apiType, signal) {
    const refs = body[key].flatMap((message) => message.attachments || []);
    assertSupported(refs, apiType);
    const bytes = refs.reduce((total, ref) => total + ref.size, 0);
    if (bytes > MAX_REQUEST_BYTES || new TextEncoder().encode(JSON.stringify(body)).length + Math.ceil(bytes / 3) * 4 > MAX_BODY_BYTES) {
      throw new Error('This conversation exceeds the attachment request limit (20 MiB originals). Remove attachments or start a new chat.');
    }
    const encoded = new Map();
    for (const message of body[key]) {
      if (!message.attachments?.length) continue;
      const parts = message.content ? [{ type: apiType === 'responses' ? 'input_text' : 'text', text: message.content }] : [];
      for (const ref of message.attachments) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        let data = encoded.get(ref.id);
        if (!data) {
          const bytes = new Uint8Array(await (await get(ref)).arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          data = `data:${ref.mime};base64,${btoa(binary)}`;
          encoded.set(ref.id, data);
        }
        if (ref.kind === 'image') parts.push(apiType === 'responses'
          ? { type: 'input_image', image_url: data, detail: 'auto' }
          : { type: 'image_url', image_url: { url: data, detail: 'auto' } });
        else parts.push(apiType === 'responses'
          ? { type: 'input_file', filename: ref.name, file_data: data }
          : { type: 'file', file: { filename: ref.name, file_data: data } });
      }
      message.content = parts;
      delete message.attachments;
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY_BYTES) throw new Error('The encoded request exceeds the 30 MiB limit. Remove attachments or start a new chat.');
    return body;
  }

  return { MAX_COUNT, MAX_REQUEST_BYTES, TYPES, validate, put, get, pin, references, collect, hydrate, assertSupported };
})();

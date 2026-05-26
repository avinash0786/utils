
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const readChunk = require('read-chunk');
const textFormat = ['csv', 'txt', 'html', 'htm', 'css', 'ini', 'json', 'tsv', 'xml', 'yaml', 'yml', 'rst', 'md'];

// Sync wrapper around ESM-only async file-type@22.
// Uses a persistent worker_threads + Atomics.wait so vatidateFile stays sync.
const SAMPLE_BYTES = 4100;
let _sync = null;
function getSyncDetector() {
    if (_sync) return _sync;
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    const workerSrc = `
        const { workerData } = require('worker_threads');
        const i32 = new Int32Array(workerData.sab);
        const port = workerData.port;
        const ftPromise = import('file-type');
        port.on('message', async (buf) => {
            let payload;
            try {
                const { fileTypeFromBuffer } = await ftPromise;
                payload = { ok: true, result: await fileTypeFromBuffer(buf) };
            } catch (e) {
                payload = { ok: false, error: e.message };
            }
            port.postMessage(payload);
            Atomics.store(i32, 0, 1);
            Atomics.notify(i32, 0);
        });
    `;
    const worker = new Worker(workerSrc, {
        eval: true,
        workerData: { sab, port: port2 },
        transferList: [port2]
    });
    worker.unref();
    _sync = function (buffer) {
        Atomics.store(i32, 0, 0);
        port1.postMessage(buffer);
        Atomics.wait(i32, 0, 0);
        const msg = receiveMessageOnPort(port1);
        if (!msg.message.ok) throw new Error(msg.message.error);
        return msg.message.result;
    };
    return _sync;
}

function toArrayBuffer(buf, length) {
    var ab = new ArrayBuffer(length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < length; ++i) {
        view[i] = buf[i];
    }
    return ab;
}

function getHex(buff, length) {
    const blob = toArrayBuffer(buff, length);
    const uint = new Uint8Array(blob);
    let bytes = [];
    uint.forEach((byte) => {
        bytes.push(byte.toString(16));
    });
    const hex = bytes.join('').toUpperCase();
    return hex;
}

function validateTextFormat(options) {
    let len = 4;
    const blob = options.type == 'Binary' ? readChunk.sync(options.path, 0, len) : toArrayBuffer(options.data, len);
    const uint = new Uint8Array(blob);
    let bytes = [];
    uint.forEach((byte) => {
        bytes.push(byte.toString(16));
    });
    return !bytes.some(_b => {
        let hex = _b.toUpperCase();
        return (hex <= 0x08 || hex == 0x0B || (0x0E <= hex && hex <= 0x1A) || (0x1C <= hex && hex <= 0x1F));
    });
}

function validateOldMSOffice(options) {
    let len = 8;
    let hex = options.type == 'Binary' ? getHex(readChunk.sync(options.path, 0, len), len) : getHex(options.data, len);
    return hex == 'D0CF11E0A1B11AE1';
}

function vatidateFile(options, ext) {
    if (textFormat.indexOf(ext) > -1) return true;
    if (['doc', 'xls', 'ppt', 'msg'].indexOf(ext) > -1) return validateOldMSOffice(options);
    let buffer = options.type == 'Binary' ? readChunk.sync(options.path, 0, SAMPLE_BYTES) : toArrayBuffer(options.data, SAMPLE_BYTES);
    //remove BOM encoding
    if (ext == 'xml') {
        let hex = options.type == 'Binary' ? getHex(readChunk.sync(options.path, 0, 3), 3) : getHex(options.data, 3);
        if (hex == 'EFBBBF')
            buffer = buffer.slice(3);
    }
    let fileTypeObj = getSyncDetector()(buffer);
    if (!fileTypeObj) return false;
    if ((fileTypeObj.ext == 'jpg' || fileTypeObj.ext == 'jpeg') && (ext == 'jpg' || ext == 'jpeg')) return true;
    return fileTypeObj.ext == ext;
}

module.exports = vatidateFile;

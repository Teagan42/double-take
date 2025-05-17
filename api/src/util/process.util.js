const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs/promises');
const perf = require('execution-time')();
const { v4: uuidv4 } = require('uuid');
const filesystem = require('./fs.util');
const database = require('./db.util');
const { parse, digest } = require('./auth.util');
const mask = require('./mask-image.util');
const sleep = require('./sleep.util');
const opencv = require('./opencv');
const { recognize, normalize } = require('./detectors/actions');
const { SERVER, STORAGE, UI } = require('../constants')();
const DETECTORS = require('../constants/config').detectors();
const config = require('../constants/config');

module.exports.polling = async (
  event,
  { retries, id, type, url, breakMatch, MATCH_IDS, delay, box }
) => {
  event.type = type;
  breakMatch = !!(breakMatch === 'true' || breakMatch === true);
  const { MATCH, UNKNOWN } = config.detect(event.camera);
  const { frigateEventType } = event;
  const allResults = [];
  const errors = {};
  let attempts = 0;
  let previousContentLength;
  const perfType = `${type}-${event.camera}-${id}`;
  perf.start(perfType);

  if (await this.isValidURL({ type, url })) {
    console.info(`url is valid: ${perf.printTimeElapsed(perfType)} sec`)
    for (let i = 0; i < retries; i++) {
      if (breakMatch === true && MATCH_IDS.includes(id)) break;

      const stream = await this.stream(url);
      console.info(`got stream: ${perf.printTimeElapsed(perfType)} sec`)
      const streamChanged = stream && previousContentLength !== stream.length;
      if (streamChanged) {
        const tmp = {
          source: `${STORAGE.TMP.PATH}/${id}-${type}-${uuidv4()}.jpg`,
          mask: false,
        };
        const filename = `${uuidv4()}.jpg`;

        attempts = i + 1;
        previousContentLength = stream.length;
        await filesystem.writer(tmp.source, stream);
        console.info(`wrote temp file: ${perf.printTimeElapsed(perfType)} sec`)

        const maskBuffer = await mask.buffer(event, tmp.source);
        console.info(`got mask buffer: ${perf.printTimeElapsed(perfType)} sec`)
        if (maskBuffer) {
          const { visible, buffer } = maskBuffer;
          tmp.mask =
            visible === true ? tmp.source : `${STORAGE.TMP.PATH}/${id}-${type}-${uuidv4()}.jpg`;
          await filesystem.writer(tmp.mask, buffer);
          console.info(`wrote mask buffer: ${perf.printTimeElapsed(perfType)} sec`)
        }

        const results = await this.start({
          id,
          event,
          perfType,
          camera: event.camera,
          filename,
          tmp: tmp.mask || tmp.source,
          attempts,
          errors,
        });

        console.info(`got results: ${perf.printTimeElapsed(perfType)} sec`)

        const foundMatch = !!results.flatMap((obj) => obj.results.filter((item) => item.match))
          .length;
        const totalFaces = results.flatMap((obj) => obj.results.filter((item) => item)).length > 0;

        if (foundMatch || (UNKNOWN.SAVE && totalFaces)) {
          await this.save(event, results, filename, maskBuffer?.visible ? tmp.mask : tmp.source);
          console.info(`matches saved: ${perf.printTimeElapsed(perfType)} sec`)
          if ((foundMatch && MATCH.BASE64) || (totalFaces && UNKNOWN.BASE64)) {
            const base64 =
              (foundMatch && MATCH.BASE64 === 'box') || (totalFaces && UNKNOWN.BASE64 === 'box')
                ? await this.stream(
                    `http://0.0.0.0:${SERVER.PORT}${UI.PATH}/api/storage/matches/${filename}?box=true`
                  )
                : stream;
            results.forEach((result) => (result.base64 = base64.toString('base64')));
            console.info(`got base64: ${perf.printTimeElapsed(perfType)} sec`)
          }
        }

        allResults.push(...results);

        if (tmp.mask) await filesystem.delete(tmp.mask);
        await filesystem.delete(tmp.source);
        console.info(`deleted temp file: ${perf.printTimeElapsed(perfType)} sec`)

        if (foundMatch) {
          MATCH_IDS.push(id);
          if (breakMatch === true) break;
        }
      }

      /* if the image hasn't changed or the user has a delay set, sleep before trying to find another image
      to increase the changes it changed */
      if ((frigateEventType && delay > 0) || !streamChanged) {
        await sleep(frigateEventType && delay > 0 ? delay : i * 0.1);
        console.info(`slept: ${perf.printTimeElapsed(perfType)} sec`)
      }
    }
  }

  const duration = parseFloat((perf.stop(perfType).time / 1000).toFixed(2));

  return {
    duration,
    type,
    attempts,
    results: allResults,
  };
};

/**
 * Saves the results of an event to a file and creates a match in the database.
 *
 * @param {string} event - The name of the event.
 * @param {object} results - The results of the event.
 * @param {string} filename - The name of the file to save the results to.
 * @param {string} tmp - The temporary directory where the file is stored.
 * @return {Promise} A promise that resolves when the results are saved and the match is created.
 */
module.exports.save = async (event, results, filename, tmp) => {
  try {
    await fsPromises.link(tmp, `${STORAGE.MEDIA.PATH}/matches/${filename}`);
    // await filesystem.writerStream(
    //   fs.createReadStream(tmp),
    //   `${STORAGE.MEDIA.PATH}/matches/${filename}`
    // );
  } catch (error) {
    error.message = `save results error: ${error.message}`;
    console.error(error);
    return;
  }

  try {
    await database.create.frigate({
      filename,
      frigateEventId: event?.frigate?.id ?? event.id,
      event: event.frigate ? JSON.stringify(event.frigate) : null
    });
    await database.create.match({ filename, event, response: results });
  } catch (error) {
    error.message = `create match error: ${error.message}`;
    console.error(error);
    return;
  }
};

module.exports.start = async ({id, perfType, event, camera, filename, tmp, attempts = 1, errors = {} }) => {
  const processed = [];
  const promises = [];

  if (!global.cv && opencv.shouldLoad()) await opencv.load();
  console.info(`loaded opencv: ${perf.printTimeElapsed(perfType)} sec`)

  for (const detector of DETECTORS) {
    if (!errors[detector]) errors[detector] = 0;

    const detectorConfig = config()?.detectors?.[detector];
    const cameraAllowed =
      (detectorConfig?.cameras || [camera]).includes(camera) || !detectorConfig?.cameras.length;
    const faceCountRequired = detectorConfig?.opencv_face_required;

    if (cameraAllowed) {
      const faces = faceCountRequired ? await opencv.faceCount(tmp) : null;
      console.info(`${detector} counted faces: ${perf.printTimeElapsed(perfType)} sec`)
      if ((faceCountRequired && faces.count > 0) || !faceCountRequired) {
        promises.push(this.process({id, faces: faces.rects, event, filename, camera, detector, tmp, errors, event }));
        processed.push(detector);
      } else console.verbose(`processing skipped for ${detector}: no faces found`);
    } else console.verbose(`processing skipped for ${detector}: ${camera} not allowed`);
  }
  let results = await Promise.all(promises);
  console.info(`detectors processed: ${perf.printTimeElapsed(perfType)} sec`)

  results = results.map((array, j) => {
    return {
      detector: processed[j],
      duration: array ? array.duration : 0,
      attempt: attempts,
      results: array ? array.results : [],
      filename,
    };
  });

  return results;
};

module.exports.process = async ({id, faces, event, filename, camera, detector, tmp, errors }) => {
  try {
    perf.start(detector);
    const { data } = await recognize({ detector, key: tmp, faces, filename, id, event });
    console.info(`detector ${detector} recognized: ${perf.printTimeElapsed(detector)} sec`)
    const duration = parseFloat((perf.stop(detector).time / 1000).toFixed(2));
    errors[detector] = 0;
    return { duration, results: normalize({ camera, detector, data }) };
  } catch (error) {
    error.message = `${detector} process error: ${error.message}`;
    if (error.code === 'ECONNABORTED') delete error.stack;
    console.error(error);
    if (error.code === 'ECONNABORTED') {
      errors[detector] += 1;
      const time = 0.5 * errors[detector];
      console.warn(`sleeping for ${time} second(s)`);
      await sleep(time);
    }
  } finally {
    console.info(`detector ${detector} finished: ${perf.printTimeElapsed(detector)} sec`)
  }
};

module.exports.isValidURL = async ({ auth = false, type, url }) => {
  const validOptions = ['image/jpg', 'image/jpeg', 'image/png'];
  try {
    const isDigest = digest.exists(url) || auth === 'digest';
    const digestAuth = isDigest ? digest(parse.url(url)) : false;
    const opts = { method: 'GET', url: isDigest ? digest.strip(url) : url, timeout: 5000 };
    const { headers } = await (digestAuth ? digestAuth.request(opts) : axios(opts));
    const isValid = !!validOptions.filter((opt) => headers['content-type'].includes(opt)).length;
    if (digestAuth) digest.add(url);

    if (!isValid)
      console.error(
        `url validation failed for ${type}: ${url} - ${headers['content-type']} not valid`
      );

    return isValid;
  } catch (error) {
    if (error?.response?.headers['www-authenticate']) {
      const authType =
        error.response.headers['www-authenticate'].toLowerCase().split(' ')[0] || false;
      if (authType === 'digest' && !auth) return this.isValidURL({ auth: authType, type, url });
    }
    error.message = `url validation error: ${error.message}`;
    console.error(error);
    return false;
  }
};

module.exports.stream = async (url) => {
  try {
    const isDigest = digest.exists(url);
    const digestAuth = isDigest ? digest(isDigest) : false;
    const opts = {
      method: 'GET',
      url: isDigest ? isDigest.url : url,
      responseType: 'arraybuffer',
      timeout: 5000,
    };
    const { data } = await (isDigest ? digestAuth.request(opts) : axios(opts));
    return data;
  } catch (error) {
    error.message = `stream error: ${error.message}`;
    console.error(error);
  }
};

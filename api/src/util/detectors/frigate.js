const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const actions = require('./actions');
const { DETECTORS } = require('../../constants')();
const config = require('../../constants/config');
const { x } = require('joi');
const e = require('express');

const { FRIGATE } = DETECTORS || {};

module.exports.recognize = async ({ key, id, event }) => {
  const { URL } = FRIGATE;
  const formData = new FormData();
  formData.append('file', fs.createReadStream(key));
  // if (KEY) formData.append('api_key', KEY);
  return await axios({
    method: 'post',
    timeout: FRIGATE.TIMEOUT * 1000,
    headers: {
      ...formData.getHeaders(),
    },
    url: `${URL}/api/faces/recognize`,
    validateStatus() {
      return true;
    },
    data: formData,
  }).then((response) => {
    const box = event?.attributes?.snapshot?.attributes?.find((a) => a.label === 'face')
      ?? event?.attributes?.snapshot?.box
      ?? event?.attributes?.box
      ?? [0,0, 100,100];
    return {
      ...response,
      data: {
        ...response.data,
        predictions: [
          {
            confidence: response.data.score,
            userid: response.data.label,
            x_min: box[0],
            y_min: box[1],
            x_max: box[2],
            y_max: box[3]
          }
        ]
      }
    }});
};

module.exports.train = ({ name, key }) => {
  const { URL } = FRIGATE;
  const formData = new FormData();
  formData.append('file', fs.createReadStream(key));
  // if (KEY) formData.append('api_key', KEY);
  return axios({
    method: 'post',
    timeout: FRIGATE.TIMEOUT * 1000,
    headers: {
      ...formData.getHeaders(),
    },
    url: `${URL}/api/faces/${name[0].toUpperCase() + name.slice(1)}/register`,
    data: formData,
  });
};

module.exports.remove = ({ name }) => {
  const { URL } = FRIGATE;
  const formData = new FormData();
  // if (KEY) formData.append('api_key', KEY);
  return axios({
    method: 'post',
    timeout: FRIGATE.TIMEOUT * 1000,
    url: `${URL}/api/faces/${name[0].toUpperCase() + name.slice(1)}/delete`,
    headers: {
      ...formData.getHeaders(),
    },
    validateStatus() {
      return true;
    },
    data: formData,
  });
};

module.exports.normalize = ({ camera, data }) => {
  if (!data.success) {
    console.warn('unexpected frigate data', data);
    return [];
  }
  const { MATCH, UNKNOWN } = config.detect(camera);
  if (!data.predictions) {
    console.warn('unexpected frigate predictions data');
    return [];
  }
  const normalized = data.predictions.flatMap((obj) => {
    const confidence = parseFloat((obj.confidence * 100).toFixed(2));
    const output = {
      name: confidence >= UNKNOWN.CONFIDENCE ? obj.userid.toLowerCase() : 'unknown',
      confidence,
      match:
        obj.userid !== 'unknown' &&
        confidence >= MATCH.CONFIDENCE &&
        (obj.x_max - obj.x_min) * (obj.y_max - obj.y_min) >= MATCH.MIN_AREA,
      box: {
        top: obj.y_min,
        left: obj.x_min,
        width: obj.x_max - obj.x_min,
        height: obj.y_max - obj.y_min,
      },
    };
    const checks = actions.checks({ MATCH, UNKNOWN, ...output });
    if (checks.length) output.checks = checks;
    return checks !== false ? output : [];
  });
  return normalized;
};

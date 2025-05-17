const axios = require('axios');
const FormData = require('form-data');
const actions = require('./actions');
const { loadImage, createCanvas } = require('canvas');
const { DETECTORS } = require('../../constants')();
const config = require('../../constants/config');

async function matToStream(mat) {
  const canvas = createCanvas(mat.width, mat.height);
  await global.cv.imshow(canvas, mat);
  return canvas.toBuffer('image/jpeg');
}

const { FRIGATE } = DETECTORS || {};

module.exports.recognize = async ({ key, faces }) => {
  const { URL } = FRIGATE;
  const {cv}  = global;
  const image = await loadImage(key);
  const src = cv.imread(image);
  const doRecognize = async (face) => {
    const formData = new FormData();
    const roi = src.roi(face);
    formData.append('file', await matToStream(roi), 'file.jpg', 'image/jpeg');
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
    }).then((response) => ({
      data: response.data,
      prediction: {
        confidence: response.data.score,
        userid: response.data.face_name,
        x_min: face.x,
        y_min: face.y,
        x_max: face.x + face.width,
        y_max: face.y + face.height,
      }
    }))
  };
  return await Promise.all(faces.map(doRecognize)).then((responses) => {
    src.delete();
    return {
      data: {
        predictions: responses.filter((response) => response.prediction.userid && response.prediction.confidence)
          .map((response) => response.prediction),
      },
    };
  });
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

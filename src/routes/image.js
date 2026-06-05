const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool, poolImages, query, queryImages } = require('../db');

const MAX_AGE_SECONDS = 604800;
const PRODUCT_IMAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 4) return 'application/octet-stream';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';
  return 'application/octet-stream';
}

function decodeBase64Image(imageFile) {
  const raw = String(imageFile || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(raw, 'base64');
}

// GET /service/v1/getImageList?item_code=
router.get('/getImageList', async (req, res) => {
  const { item_code } = req.query;
  try {
    const result = await queryImages(
      'SELECT image_id, guid_code FROM images WHERE image_id = $1 ORDER BY image_order ASC',
      [item_code || '']
    );
    return res.set('Cache-Control', 'no-store').json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(400).set('Cache-Control', 'no-store').json({ ERROR: ex.message });
  }
});

// GET /service/v1/getDocImagesList?doc_no=
router.get('/getDocImagesList', async (req, res) => {
  const { doc_no = '' } = req.query;
  try {
    const result = await query(
      'SELECT guid_code, image_id FROM sml_doc_images WHERE image_id = $1 ORDER BY image_order ASC',
      [doc_no]
    );
    const data = result.rows.map(r => ({
      guid_code: r.guid_code || '',
      doc_no: r.image_id || '',
    }));
    return res.json({ success: true, data });
  } catch (ex) {
    console.log('getDocImagesList error:', ex.message);
    return res.json({ success: true, data: [] });
  }
});

// POST /service/v1/saveDocImage
router.post('/saveDocImage', async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body) body = {};

    const docNoRaw = String(body.doc_no || '');
    const docNos = [...new Set(docNoRaw.split(',').map(v => v.trim()).filter(Boolean))];
    if (docNos.length === 0) {
      return res.status(400).json({ success: false, msg: 'doc_no is empty' });
    }

    const imageBytes = decodeBase64Image(body.image_file);
    if (!imageBytes.length) {
      return res.status(400).json({ success: false, msg: 'image_file is empty' });
    }

    const clientImages = await poolImages.connect();
    const clientMain = await pool.connect();
    try {
      await clientImages.query('BEGIN');
      await clientMain.query('BEGIN');

      for (const docNo of docNos) {
        const guid = crypto.randomUUID();
        await clientImages.query(
          'INSERT INTO sml_doc_images (image_id, image_file, system_id, guid_code, image_order) VALUES ($1,$2,$3,$4,$5)',
          [docNo, imageBytes, '', guid, 0]
        );
        await clientMain.query(
          'INSERT INTO sml_doc_images (image_id, system_id, guid_code, image_order) VALUES ($1,$2,$3,$4)',
          [docNo, '', guid, 0]
        );
      }

      await clientImages.query('COMMIT');
      await clientMain.query('COMMIT');
    } catch (ex) {
      await clientImages.query('ROLLBACK').catch(() => {});
      await clientMain.query('ROLLBACK').catch(() => {});
      throw ex;
    } finally {
      clientImages.release();
      clientMain.release();
    }

    return res.json({ success: true, msg: 'success' });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/deleteDocImage?guid_code=
router.get('/deleteDocImage', async (req, res) => {
  const { guid_code = '' } = req.query;
  try {
    await queryImages('DELETE FROM sml_doc_images WHERE guid_code = $1', [guid_code]);
    await query('DELETE FROM sml_doc_images WHERE guid_code = $1', [guid_code]);
    return res.json({ success: true });
  } catch (ex) {
    console.log('deleteDocImage error:', ex.message);
    return res.json({ success: true });
  }
});

// GET /service/v1/getDocImage/:guid_code
router.get('/getDocImage/:guid_code', async (req, res) => {
  const guidCode = String(req.params.guid_code || '').trim();
  if (!guidCode) return res.status(400).end();

  try {
    const result = await queryImages(
      'SELECT image_file FROM sml_doc_images WHERE guid_code = $1 LIMIT 1',
      [guidCode]
    );

    if (result.rows.length === 0 || !result.rows[0].image_file) {
      return res.status(404).end();
    }

    const imageBytes = result.rows[0].image_file;
    const etag = crypto.createHash('md5').update(imageBytes).digest('hex');

    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res
        .status(304)
        .set('Cache-Control', 'public, max-age=86400')
        .set('ETag', `"${etag}"`)
        .end();
    }

    return res
      .status(200)
      .type(detectImageMime(imageBytes))
      .set('Cache-Control', 'public, max-age=86400')
      .set('ETag', `"${etag}"`)
      .set('Content-Length', String(imageBytes.length))
      .send(imageBytes);
  } catch (ex) {
    return res.status(500).type('text/plain').send('ERROR: ' + ex.message);
  }
});

// GET /service/v1/images?item_code=
router.get('/images', async (req, res) => {
  const { item_code } = req.query;
  if (!item_code || item_code.trim() === '') {
    return res.status(400).type('text/plain').send('ERROR: item_code is required');
  }

  try {
    const result = await queryImages(
      'SELECT image_file FROM images WHERE image_id = $1  limit 1',
      [item_code]
    );

    if (result.rows.length === 0 || !result.rows[0].image_file) {
      return res.status(404)
        .type('text/plain')
        .set('Cache-Control', 'no-store')
        .send('ERROR: image not found');
    }

    const imageBytes = result.rows[0].image_file;
    const etag = crypto.createHash('md5').update(imageBytes).digest('hex');

    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res
        .status(304)
        .set('Cache-Control', PRODUCT_IMAGE_CACHE_CONTROL)
        .set('ETag', `"${etag}"`)
        .end();
    }

    return res
      .status(200)
      .type(detectImageMime(imageBytes))
      .set('Cache-Control', PRODUCT_IMAGE_CACHE_CONTROL)
      .set('ETag', `"${etag}"`)
      .set('Content-Length', String(imageBytes.length))
      .send(imageBytes);
  } catch (ex) {
    return res.status(500).type('text/plain').send('ERROR: ' + ex.message);
  }
});

// GET /service/v1/imagesguid?guid_code=
router.get('/imagesguid', async (req, res) => {
  const { guid_code } = req.query;
  try {
    const result = await queryImages(
      'SELECT image_file FROM images WHERE guid_code = $1 limit 1',
      [guid_code || '']
    );

    if (result.rows.length === 0 || !result.rows[0].image_file) {
      return res.status(200)
        .type('image/png')
        .set('Cache-Control', 'no-store')
        .send(Buffer.alloc(0));
    }

    const imageBytes = result.rows[0].image_file;
    const etag = crypto.createHash('md5').update(imageBytes).digest('hex');

    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res
        .status(304)
        .set('Cache-Control', PRODUCT_IMAGE_CACHE_CONTROL)
        .set('ETag', `"${etag}"`)
        .end();
    }

    return res
      .status(200)
      .type(detectImageMime(imageBytes))
      .set('Cache-Control', PRODUCT_IMAGE_CACHE_CONTROL)
      .set('ETag', `"${etag}"`)
      .set('Content-Length', String(imageBytes.length))
      .send(imageBytes);
  } catch (_) {
    return res.status(200).type('image/png').send(Buffer.alloc(0));
  }
});

module.exports = router;

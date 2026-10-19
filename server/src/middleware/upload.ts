import multer from 'multer';
import { BadRequestError } from '../utils/errors.js';
import { MAX_FILE_SIZE_BYTES } from '../lib/cloudinary.js';

export const uploadCoverMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'));
    }
  },
});

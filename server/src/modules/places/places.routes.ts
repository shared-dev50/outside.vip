import { Router } from 'express';
import {
  autocompletePlaces,
  getDetails,
  checkPlacesStatus,
} from './places.controller.js';

export const placesRouter = Router();

placesRouter.get('/status', checkPlacesStatus);
placesRouter.get('/autocomplete', autocompletePlaces);
placesRouter.get('/details/:placeId', getDetails);

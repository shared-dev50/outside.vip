import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env.js';
import {
  getAutocompleteSuggestions,
  getPlaceDetails,
  isGooglePlacesConfigured,
} from './places.service.js';
import { BadRequestError } from '../../utils/errors.js';

export async function checkPlacesStatus(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    res.json({
      success: true,
      data: {
        configured: isGooglePlacesConfigured(),
        defaultCountryCode: (env.DEFAULT_PLACES_COUNTRY_CODE || 'US').trim().toUpperCase(),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function autocompletePlaces(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = typeof req.query.input === 'string' ? req.query.input : '';
    const sessionToken = typeof req.query.sessionToken === 'string' ? req.query.sessionToken : undefined;
    const countryCode = typeof req.query.countryCode === 'string' ? req.query.countryCode : undefined;

    const result = await getAutocompleteSuggestions({
      input,
      sessionToken,
      countryCode,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDetails(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const placeId = (req.params.placeId || '').trim();
    if (!placeId) {
      throw new BadRequestError('Place ID is required');
    }

    const sessionToken = typeof req.query.sessionToken === 'string' ? req.query.sessionToken : undefined;

    const result = await getPlaceDetails({
      placeId,
      sessionToken,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

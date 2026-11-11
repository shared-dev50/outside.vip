import { env } from '../../config/env.js';
import { BadRequestError } from '../../utils/errors.js';
import { inferTimezoneFromLocation } from '../../utils/timezone.js';

export interface PlaceSuggestion {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
  types: string[];
}

export interface PlaceDetailsResult {
  placeId: string;
  venueName: string;
  venueAddress: string;
  latitude: number | null;
  longitude: number | null;
  city: string;
  stateCode?: string | null;
  country: string;
  countryCode?: string | null;
  suggestedTimezone?: string | null;
}

export interface AutocompleteResponse {
  configured: boolean;
  suggestions: PlaceSuggestion[];
}

export interface PlaceDetailsResponse {
  configured: boolean;
  details: PlaceDetailsResult | null;
}

export function getGoogleApiKey(): string {
  return env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY || '';
}

export function isGooglePlacesConfigured(): boolean {
  return getGoogleApiKey().trim().length > 0;
}

/**
 * Request autocomplete suggestions from Google Places API (New).
 */
export async function getAutocompleteSuggestions(params: {
  input: string;
  sessionToken?: string;
  countryCode?: string;
}): Promise<AutocompleteResponse> {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    return {
      configured: false,
      suggestions: [],
    };
  }

  const trimmedInput = params.input.trim();
  if (!trimmedInput) {
    return {
      configured: true,
      suggestions: [],
    };
  }

  // Configurable default country (defaults to US)
  const defaultCountry = (env.DEFAULT_PLACES_COUNTRY_CODE || 'US').trim().toUpperCase();
  const requestedCountry = params.countryCode !== undefined ? params.countryCode.trim().toUpperCase() : defaultCountry;

  // Support international / worldwide searching when requested or configured as ALL/GLOBAL
  const isWorldwide = !requestedCountry || requestedCountry === 'ALL' || requestedCountry === 'GLOBAL' || requestedCountry === 'WORLDWIDE';

  const requestBody: Record<string, any> = {
    input: trimmedInput,
  };

  if (!isWorldwide) {
    requestBody.includedRegionCodes = [requestedCountry];
  }

  if (params.sessionToken && params.sessionToken.trim()) {
    requestBody.sessionToken = params.sessionToken.trim();
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Google Places Autocomplete HTTP ${response.status}:`, errText);
      return {
        configured: true,
        suggestions: [],
      };
    }

    const data: any = await response.json();
    const rawSuggestions = data.suggestions || [];

    const suggestions: PlaceSuggestion[] = rawSuggestions
      .map((s: any) => {
        const pred = s.placePrediction;
        if (!pred) return null;

        const rawPlaceId = pred.placeId || (pred.place ? pred.place.replace(/^places\//, '') : '');
        if (!rawPlaceId) return null;

        const mainText = pred.structuredFormat?.mainText?.text || pred.text?.text || '';
        const secondaryText = pred.structuredFormat?.secondaryText?.text || '';
        const text = pred.text?.text || `${mainText}${secondaryText ? `, ${secondaryText}` : ''}`;

        return {
          placeId: rawPlaceId,
          text,
          mainText,
          secondaryText,
          types: pred.types || [],
        };
      })
      .filter((s: PlaceSuggestion | null): s is PlaceSuggestion => s !== null);

    return {
      configured: true,
      suggestions,
    };
  } catch (error: any) {
    console.error('Error fetching Google Places autocomplete suggestions:', error.message);
    return {
      configured: true,
      suggestions: [],
    };
  }
}

/**
 * Retrieve Place Details from Google Places API (New).
 */
export async function getPlaceDetails(params: {
  placeId: string;
  sessionToken?: string;
}): Promise<PlaceDetailsResponse> {
  const rawPlaceId = (params.placeId || '').trim();
  if (!rawPlaceId) {
    throw new BadRequestError('Place ID is required');
  }

  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    return {
      configured: false,
      details: null,
    };
  }

  const cleanPlaceId = rawPlaceId.replace(/^places\//, '');
  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(cleanPlaceId)}`);
  
  if (params.sessionToken && params.sessionToken.trim()) {
    url.searchParams.set('sessionToken', params.sessionToken.trim());
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,addressComponents',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Google Places Details HTTP ${response.status}:`, errText);
      if (response.status === 404 || response.status === 400) {
        throw new BadRequestError(`Invalid or unrecognized Google Place ID: ${cleanPlaceId}`);
      }
      return {
        configured: true,
        details: null,
      };
    }

    const data: any = await response.json();

    const venueName = data.displayName?.text || '';
    const venueAddress = data.formattedAddress || '';
    const latitude = typeof data.location?.latitude === 'number' ? data.location.latitude : null;
    const longitude = typeof data.location?.longitude === 'number' ? data.location.longitude : null;

    let city = '';
    let stateCode: string | null = null;
    let country = 'United States';
    let countryCode: string | null = null;

    if (Array.isArray(data.addressComponents)) {
      for (const comp of data.addressComponents) {
        const types: string[] = comp.types || [];
        if (types.includes('locality') || types.includes('postal_town')) {
          city = comp.longText || comp.shortText || city;
        } else if (!city && types.includes('administrative_area_level_2')) {
          city = comp.longText || comp.shortText || city;
        } else if (!city && types.includes('sublocality')) {
          city = comp.longText || comp.shortText || city;
        }

        if (types.includes('administrative_area_level_1')) {
          stateCode = comp.shortText || comp.longText || null;
          if (!city && stateCode) {
            city = comp.longText || comp.shortText || city;
          }
        }

        if (types.includes('country')) {
          country = comp.longText || comp.shortText || country;
          countryCode = comp.shortText || null;
        }
      }
    }

    const suggestedTimezone = inferTimezoneFromLocation({
      latitude,
      longitude,
      stateCode,
      country,
      countryCode,
    });

    return {
      configured: true,
      details: {
        placeId: cleanPlaceId,
        venueName,
        venueAddress,
        latitude,
        longitude,
        city,
        stateCode,
        country,
        countryCode,
        suggestedTimezone,
      },
    };
  } catch (error: any) {
    if (error instanceof BadRequestError) {
      throw error;
    }
    console.error('Error fetching Google Place details:', error.message);
    throw new BadRequestError(`Failed to fetch details for Place ID: ${cleanPlaceId}`);
  }
}

/**
 * Validates and normalizes location data on the backend.
 * Verifies Google Place IDs server-side rather than trusting client-submitted coordinates,
 * and clears placeId/coordinates when saving manual venue entries.
 */
export async function verifyAndNormalizeLocation(data: {
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  placeId?: string | null;
}): Promise<{
  venueName: string;
  venueAddress: string;
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
}> {
  const hasPlaceId = typeof data.placeId === 'string' && data.placeId.trim().length > 0;

  if (hasPlaceId) {
    const placeId = data.placeId!.trim().replace(/^places\//, '');
    
    if (isGooglePlacesConfigured()) {
      // Fetch authoritative details from Google
      const detailsResult = await getPlaceDetails({ placeId });
      if (!detailsResult.details) {
        throw new BadRequestError(`Could not verify Google Place ID: ${placeId}`);
      }

      const verified = detailsResult.details;

      return {
        // Allow organizer-customized venue name if provided, else use Google's displayName
        venueName: (data.venueName && data.venueName.trim()) ? data.venueName.trim() : verified.venueName,
        // Authoritative formatted address from Google unless overridden
        venueAddress: (data.venueAddress && data.venueAddress.trim()) ? data.venueAddress.trim() : verified.venueAddress,
        city: (data.city && data.city.trim()) ? data.city.trim() : verified.city,
        country: (data.country && data.country.trim()) ? data.country.trim() : verified.country,
        // Authoritative coordinates directly from Google
        latitude: verified.latitude,
        longitude: verified.longitude,
        placeId: verified.placeId,
      };
    } else {
      // If Google Places API is unconfigured on server (e.g. testing or self-hosted without Maps key),
      // validate client coordinates bounds strictly
      if (data.latitude !== null && data.latitude !== undefined) {
        if (typeof data.latitude !== 'number' || data.latitude < -90 || data.latitude > 90) {
          throw new BadRequestError('Latitude must be a valid number between -90 and 90');
        }
      }
      if (data.longitude !== null && data.longitude !== undefined) {
        if (typeof data.longitude !== 'number' || data.longitude < -180 || data.longitude > 180) {
          throw new BadRequestError('Longitude must be a valid number between -180 and 180');
        }
      }

      return {
        venueName: (data.venueName || '').trim(),
        venueAddress: (data.venueAddress || '').trim(),
        city: (data.city || '').trim(),
        country: (data.country || 'United States').trim(),
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        placeId,
      };
    }
  }

  // Manual mode or no placeId selected: clear placeId and coordinates so stale values are not retained
  return {
    venueName: (data.venueName || '').trim(),
    venueAddress: (data.venueAddress || '').trim(),
    city: (data.city || '').trim(),
    country: (data.country || 'United States').trim(),
    latitude: null,
    longitude: null,
    placeId: null,
  };
}

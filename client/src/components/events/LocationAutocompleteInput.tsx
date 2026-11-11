import React, { useState, useEffect, useRef, useId } from 'react';
import {
  MapPin,
  Search,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Building2,
  ExternalLink,
  Sparkles,
  Globe,
} from 'lucide-react';
import { api } from '../../lib/api';

export interface LocationData {
  venueName: string;
  venueAddress: string;
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
}

export interface LocationAutocompleteInputProps {
  value: LocationData;
  onChange: (value: LocationData) => void;
  onTimezoneSuggested?: (suggestedTimezone: string) => void;
  countryCode?: string;
  className?: string;
  disabled?: boolean;
}

function generateSessionToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const LocationAutocompleteInput: React.FC<LocationAutocompleteInputProps> = ({
  value,
  onChange,
  onTimezoneSuggested,
  countryCode: propCountryCode,
  className = '',
  disabled = false,
}) => {
  const componentInstanceId = useId();
  // If placeId exists, we are in Google mode with a selected location.
  // If no placeId but venueName exists, we preserve manual mode for backward compatibility.
  const isLegacyOrManual = !value.placeId && (Boolean(value.venueName) || Boolean(value.venueAddress));
  const [isManualMode, setIsManualMode] = useState<boolean>(isLegacyOrManual);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isFetchingDetails, setIsFetchingDetails] = useState<boolean>(false);
  const [suggestions, setSuggestions] = useState<
    Array<{
      placeId: string;
      text: string;
      mainText: string;
      secondaryText: string;
      types: string[];
    }>
  >([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Active search region: defaults to US, configurable, toggleable to Worldwide ('ALL')
  const [searchRegion, setSearchRegion] = useState<string>(propCountryCode || 'US');
  const [backendDefaultCountry, setBackendDefaultCountry] = useState<string>('US');

  const [isChangingLocation, setIsChangingLocation] = useState<boolean>(false);

  // Session token for Google Places billing
  const sessionTokenRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Check if Places API is configured on the backend and get default region
  useEffect(() => {
    let isMounted = true;
    api.places
      .status()
      .then((res) => {
        if (isMounted) {
          const configured = res?.configured ?? false;
          setApiConfigured(configured);
          if (res?.defaultCountryCode) {
            setBackendDefaultCountry(res.defaultCountryCode);
            if (!propCountryCode) {
              setSearchRegion(res.defaultCountryCode);
            }
          }
          if (!configured && !value.placeId) {
            setIsManualMode(true);
          }
        }
      })
      .catch(() => {
        if (isMounted) {
          setApiConfigured(false);
          if (!value.placeId) {
            setIsManualMode(true);
          }
        }
      });

    return () => {
      isMounted = false;
    };
  }, [value.placeId, propCountryCode]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced autocomplete query
  useEffect(() => {
    if (isManualMode) return;

    const trimmed = searchQuery.trim();
    if (!trimmed || trimmed.length < 2) {
      setSuggestions([]);
      setIsDropdownOpen(false);
      return;
    }

    if (!sessionTokenRef.current) {
      sessionTokenRef.current = generateSessionToken();
    }

    setIsSearching(true);
    setErrorMessage(null);

    const timer = setTimeout(async () => {
      try {
        const res = await api.places.autocomplete({
          input: trimmed,
          sessionToken: sessionTokenRef.current || undefined,
          countryCode: searchRegion,
        });

        if (res?.configured === false) {
          setApiConfigured(false);
          setIsManualMode(true);
          setIsDropdownOpen(false);
          return;
        }

        const items = res?.suggestions || [];
        setSuggestions(items);
        setIsDropdownOpen(true);
      } catch (err: any) {
        setErrorMessage('Unable to load location suggestions. You can enter the location manually.');
        setSuggestions([]);
      } finally {
        setIsSearching(false);
      }
    }, 280);

    return () => clearTimeout(timer);
  }, [searchQuery, searchRegion, isManualMode]);

  const handleSelectSuggestion = async (placeId: string, mainText: string) => {
    setIsFetchingDetails(true);
    setErrorMessage(null);
    setIsDropdownOpen(false);

    try {
      const res = await api.places.details(placeId, sessionTokenRef.current || undefined);
      // Reset session token after Place Details request completes
      sessionTokenRef.current = null;

      if (res?.details) {
        const details = res.details;
        onChange({
          venueName: details.venueName || mainText,
          venueAddress: details.venueAddress || '',
          city: details.city || value.city || '',
          country: details.country || value.country || 'United States',
          latitude: details.latitude,
          longitude: details.longitude,
          placeId: details.placeId,
        });

        if (details.suggestedTimezone && onTimezoneSuggested) {
          onTimezoneSuggested(details.suggestedTimezone);
        }

        setSearchQuery('');
        setIsChangingLocation(false);
      } else {
        setErrorMessage('Could not retrieve place details. Please try another place or enter manually.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to retrieve details for selected place.');
    } finally {
      setIsFetchingDetails(false);
    }
  };

  const handleClearLocation = () => {
    onChange({
      venueName: '',
      venueAddress: '',
      city: '',
      country: 'United States',
      latitude: null,
      longitude: null,
      placeId: null,
    });
    setSearchQuery('');
    setSuggestions([]);
    setIsChangingLocation(false);
    sessionTokenRef.current = null;
  };

  const handleSwitchToManual = () => {
    setIsManualMode(true);
    setIsChangingLocation(false);
    setIsDropdownOpen(false);

    onChange({
      venueName: value.venueName,
      venueAddress: value.venueAddress,
      city: value.city,
      country: value.country || 'United States',
      latitude: null,
      longitude: null,
      placeId: null,
    });
  };

  const handleSwitchToGoogle = () => {
    setIsManualMode(false);
    setErrorMessage(null);
    sessionTokenRef.current = generateSessionToken();
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
  };

  // Custom venue name change while preserving coordinates and placeId
  const handleCustomVenueNameChange = (newName: string) => {
    onChange({
      ...value,
      venueName: newName,
    });
  };

  const handleManualChange = (field: keyof LocationData, val: any) => {
    onChange({
      ...value,
      [field]: val,
      // Ensure placeId and coordinates remain null in manual mode
      placeId: null,
      latitude: null,
      longitude: null,
    });
  };

  const googleMapsUrl = value.placeId
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      value.venueAddress || value.venueName
    )}&query_place_id=${encodeURIComponent(value.placeId)}`
    : value.latitude && value.longitude
      ? `https://www.google.com/maps/search/?api=1&query=${value.latitude},${value.longitude}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${value.venueName}, ${value.venueAddress}, ${value.city}`
      )}`;

  return (
    <div ref={containerRef} className={`space-y-4 ${className}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-1">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-emerald-600" />
              Physical Venue & Destination
            </h3>
            {value.placeId && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                Google Verified
              </span>
            )}
            {isLegacyOrManual && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-stone-100 text-stone-600 border border-stone-200">
                Custom / Manual
              </span>
            )}
          </div>
          <p className="text-xs text-stone-500 mt-0.5 font-sans">
            Where will attendees arrive for this experience?
          </p>
        </div>

        {apiConfigured !== false && (
          <div className="flex items-center">
            {isManualMode ? (
              <button
                type="button"
                onClick={handleSwitchToGoogle}
                disabled={disabled}
                className="inline-flex items-center gap-1 text-xs font-mono text-emerald-700 hover:text-emerald-800 font-semibold transition-colors py-1 px-2 rounded hover:bg-emerald-50 border border-transparent hover:border-emerald-200"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Search with Google Places</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSwitchToManual}
                disabled={disabled}
                className="inline-flex items-center gap-1 text-xs font-mono text-stone-500 hover:text-stone-800 transition-colors py-1 px-2 rounded hover:bg-stone-100"
              >
                <span>Enter venue manually</span>
              </button>
            )}
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="flex items-center justify-between gap-2 p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={handleSwitchToManual}
            className="text-rose-800 font-bold underline hover:no-underline font-mono text-[11px]"
          >
            Switch to manual entry
          </button>
        </div>
      )}

      {!isManualMode && value.placeId && !isChangingLocation && (
        <div className="rounded-xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50/40 to-white p-4 space-y-4 shadow-sm transition-all">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                <Building2 className="w-5 h-5 text-emerald-700" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono font-bold text-stone-500 uppercase tracking-wider">
                    Selected Place
                  </span>
                  <span className="text-[10px] font-mono text-stone-400">
                    ID: {value.placeId.slice(0, 14)}...
                  </span>
                </div>
                <div className="text-sm font-display font-bold text-stone-900 truncate mt-0.5">
                  {value.venueName || 'Venue Selected'}
                </div>
                {value.venueAddress && (
                  <p className="text-xs text-stone-600 font-sans mt-0.5 break-words">
                    {value.venueAddress}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-stone-500">
                  {(value.city || value.country) && (
                    <span className="bg-stone-100 px-2 py-0.5 rounded text-stone-700 font-medium">
                      {[value.city, value.country].filter(Boolean).join(', ')}
                    </span>
                  )}
                  {value.latitude !== null && value.longitude !== null && (
                    <span className="text-stone-400 hidden sm:inline">
                      {value.latitude.toFixed(4)}, {value.longitude.toFixed(4)}
                    </span>
                  )}
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-900 hover:underline font-sans"
                  >
                    <span>View on Google Maps</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setIsChangingLocation(true);
                  setSearchQuery('');
                  sessionTokenRef.current = generateSessionToken();
                  setTimeout(() => {
                    searchInputRef.current?.focus();
                  }, 50);
                }}
                disabled={disabled}
                className="px-2.5 py-1.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-xs font-mono transition-colors shadow-2xs hover:border-stone-300"
              >
                Change
              </button>
              <button
                type="button"
                onClick={handleClearLocation}
                disabled={disabled}
                aria-label="Clear location"
                title="Clear selected location"
                className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="pt-3 border-t border-emerald-100/60">
            <label
              htmlFor={`venue-display-name-${componentInstanceId}`}
              className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5"
            >
              Customise Venue Display Name
            </label>
            <input
              id={`venue-display-name-${componentInstanceId}`}
              type="text"
              value={value.venueName}
              onChange={(e) => handleCustomVenueNameChange(e.target.value)}
              placeholder="e.g. The Brooklyn Mirage"
              disabled={disabled}
              className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 transition-colors shadow-2xs"
            />
            <p className="text-[11px] text-stone-500 mt-1 font-sans">
              You can adjust how the venue name appears to attendees without altering Google Maps coordinates.
            </p>
          </div>
        </div>
      )}

      {!isManualMode && (!value.placeId || isChangingLocation) && (
        <div className="space-y-3 relative">
          {isChangingLocation && value.placeId && (
            <div className="flex items-center justify-between text-xs font-mono bg-stone-50 px-3 py-1.5 rounded-md border border-stone-200 text-stone-600">
              <span>Current location kept until a new place is selected:</span>
              <button
                type="button"
                onClick={() => {
                  setIsChangingLocation(false);
                  setSearchQuery('');
                }}
                className="text-stone-900 font-bold hover:underline"
              >
                Cancel change
              </button>
            </div>
          )}

          <div className="relative">
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor={`places-search-input-${componentInstanceId}`}
                className="block text-xs font-mono uppercase text-stone-700 font-bold"
              >
                Search Venue or Destination <span className="text-rose-600">*</span>
              </label>

              <div className="flex items-center gap-1.5 text-xs font-mono">
                <button
                  type="button"
                  onClick={() => setSearchRegion(backendDefaultCountry || 'US')}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                    searchRegion !== 'ALL'
                      ? 'bg-stone-900 text-white font-bold'
                      : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                  }`}
                  title="Search United States venues"
                >
                  US First
                </button>
                <button
                  type="button"
                  onClick={() => setSearchRegion('ALL')}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                    searchRegion === 'ALL'
                      ? 'bg-stone-900 text-white font-bold'
                      : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                  }`}
                  title="Search international and worldwide locations"
                >
                  Worldwide
                </button>
              </div>
            </div>

            <div className="relative flex items-center">
              <Search className="w-4 h-4 text-stone-400 absolute left-3.5 pointer-events-none" />
              <input
                ref={searchInputRef}
                id={`places-search-input-${componentInstanceId}`}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                }}
                onFocus={() => {
                  if (suggestions.length > 0) {
                    setIsDropdownOpen(true);
                  }
                }}
                placeholder={
                  searchRegion === 'ALL'
                    ? 'Search venue name, club, rooftop, hotel or street address worldwide...'
                    : 'Search venue name, club, rooftop, hotel or street address in the US...'
                }
                disabled={disabled || isFetchingDetails}
                autoComplete="off"
                className="w-full pl-10 pr-10 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors"
              />
              <div className="absolute right-3 flex items-center gap-1.5">
                {isSearching || isFetchingDetails ? (
                  <Loader2 className="w-4 h-4 text-emerald-600 animate-spin" />
                ) : searchQuery ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSuggestions([]);
                      setIsDropdownOpen(false);
                    }}
                    className="text-stone-400 hover:text-stone-700"
                  >
                    <X className="w-4 h-4" />
                  </button>
                ) : null}
              </div>
            </div>

            {isDropdownOpen && (
              <div className="absolute z-40 left-0 right-0 mt-1.5 bg-white border border-stone-200 rounded-xl shadow-xl overflow-hidden max-h-72 overflow-y-auto divide-y divide-stone-100">
                {suggestions.length > 0 ? (
                  <>
                    {suggestions.map((item) => (
                      <button
                        key={item.placeId}
                        type="button"
                        onClick={() => handleSelectSuggestion(item.placeId, item.mainText)}
                        className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors flex items-start gap-3 group focus:outline-none focus:bg-emerald-50/50"
                      >
                        <MapPin className="w-4 h-4 text-stone-400 group-hover:text-emerald-600 mt-0.5 shrink-0 transition-colors" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-stone-900 group-hover:text-emerald-950 truncate">
                            {item.mainText}
                          </p>
                          {item.secondaryText && (
                            <p className="text-xs text-stone-500 truncate mt-0.5">
                              {item.secondaryText}
                            </p>
                          )}
                        </div>
                      </button>
                    ))}

                    {/* Google Required Attribution */}
                    <div className="px-4 py-2 bg-stone-50 flex items-center justify-between text-[11px] text-stone-400 font-sans border-t border-stone-100">
                      <span className="text-[10px] uppercase font-mono tracking-wider">
                        Google Places API
                      </span>
                      <div className="flex items-center gap-1 text-stone-500 font-medium">
                        <span>powered by</span>
                        <span className="font-bold text-stone-700 tracking-tight">Google</span>
                      </div>
                    </div>
                  </>
                ) : searchQuery.trim().length >= 2 && !isSearching ? (
                  <div className="p-4 text-center space-y-2">
                    <p className="text-xs text-stone-500 font-sans">
                      No matching places found for &quot;{searchQuery}&quot;.
                    </p>
                    <button
                      type="button"
                      onClick={handleSwitchToManual}
                      className="inline-flex items-center gap-1 text-xs font-mono font-bold text-emerald-700 hover:underline"
                    >
                      Enter location details manually &rarr;
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-[11px] text-stone-500 flex-wrap gap-2">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-stone-400" />
              <span>
                {searchRegion === 'ALL'
                  ? 'Searching international locations'
                  : `Default search region: ${searchRegion}`}
              </span>
            </div>
            <button
              type="button"
              onClick={handleSwitchToManual}
              className="text-stone-600 hover:text-stone-900 font-mono hover:underline"
            >
              Can&apos;t find your venue? Enter manually
            </button>
          </div>
        </div>
      )}

      {isManualMode && (
        <div className="space-y-4 p-4 rounded-xl border border-stone-200 bg-[#FAF8F5]/60">
          <div className="flex items-center justify-between pb-2 border-b border-stone-200">
            <span className="text-xs font-mono font-bold text-stone-700 uppercase tracking-wider flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-stone-500" />
              Manual Location Entry
            </span>
            {apiConfigured !== false && (
              <button
                type="button"
                onClick={handleSwitchToGoogle}
                className="text-xs font-mono text-emerald-700 font-bold hover:underline"
              >
                Switch to Google Search &rarr;
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor={`manual-venue-name-${componentInstanceId}`}
                className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5"
              >
                Venue Name <span className="text-rose-600">*</span>
              </label>
              <input
                id={`manual-venue-name-${componentInstanceId}`}
                type="text"
                placeholder="e.g. The Brooklyn Mirage"
                value={value.venueName}
                onChange={(e) => handleManualChange('venueName', e.target.value)}
                disabled={disabled}
                className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 transition-colors shadow-2xs"
              />
            </div>

            <div>
              <label
                htmlFor={`manual-city-${componentInstanceId}`}
                className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5"
              >
                City <span className="text-rose-600">*</span>
              </label>
              <input
                id={`manual-city-${componentInstanceId}`}
                type="text"
                placeholder="e.g. Brooklyn, NY"
                value={value.city}
                onChange={(e) => handleManualChange('city', e.target.value)}
                disabled={disabled}
                className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 transition-colors shadow-2xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label
                htmlFor={`manual-venue-address-${componentInstanceId}`}
                className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5"
              >
                Physical Address
              </label>
              <input
                id={`manual-venue-address-${componentInstanceId}`}
                type="text"
                placeholder="Street address, building or landmark"
                value={value.venueAddress}
                onChange={(e) => handleManualChange('venueAddress', e.target.value)}
                disabled={disabled}
                className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 transition-colors shadow-2xs"
              />
            </div>

            <div>
              <label
                htmlFor={`manual-country-${componentInstanceId}`}
                className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5"
              >
                Country
              </label>
              <input
                id={`manual-country-${componentInstanceId}`}
                type="text"
                placeholder="e.g. United States"
                value={value.country || 'United States'}
                onChange={(e) => handleManualChange('country', e.target.value)}
                disabled={disabled}
                className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 transition-colors shadow-2xs"
              />
            </div>
          </div>

          <div className="text-[11px] font-mono text-stone-400 pt-1">
            In manual mode, location coordinates and Google Place ID are saved as null.
          </div>
        </div>
      )}
    </div>
  );
};

import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { api, setActiveCsrfToken } from '../lib/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: {
    email: string;
    password: string;
    name: string;
    role?: string;
    organizerDisplayName?: string;
  }) => Promise<void>;
  verifyEmail: (code: string) => Promise<User>;
  resendVerification: () => Promise<{ message: string; cooldownSeconds: number }>;
  refreshUser: () => Promise<User | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshUser = async (): Promise<User | null> => {
    try {
      const { user: fetchedUser, csrfToken } = await api.auth.me();
      if (csrfToken) {
        setActiveCsrfToken(csrfToken);
      }
      setUser(fetchedUser);
      return fetchedUser;
    } catch {
      setActiveCsrfToken(null);
      setUser(null);
      return null;
    }
  };

  useEffect(() => {
    let isMounted = true;

    async function loadUserSession() {
      try {
        const { user: fetchedUser, csrfToken } = await api.auth.me();
        if (!isMounted) return;
        if (csrfToken) {
          setActiveCsrfToken(csrfToken);
        }
        setUser(fetchedUser);
      } catch {
        if (!isMounted) return;
        setActiveCsrfToken(null);
        setUser(null);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadUserSession();
    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (email: string, password: string) => {
    const data = await api.auth.login({ email, password });
    if (data.csrfToken) {
      setActiveCsrfToken(data.csrfToken);
    }
    setUser(data.user);
  };

  const register = async (input: {
    email: string;
    password: string;
    name: string;
    role?: string;
    organizerDisplayName?: string;
  }) => {
    const data = await api.auth.register(input);
    if (data.csrfToken) {
      setActiveCsrfToken(data.csrfToken);
    }
    setUser(data.user);
  };

  const verifyEmail = async (code: string): Promise<User> => {
    const data = await api.auth.verifyEmail({ code });
    if (data.csrfToken) {
      setActiveCsrfToken(data.csrfToken);
    }
    setUser(data.user);
    return data.user;
  };

  const resendVerification = async () => {
    const data = await api.auth.resendVerification();
    return {
      message: data.message,
      cooldownSeconds: data.cooldownSeconds,
    };
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Ensure client state clears even if network is offline
    } finally {
      setActiveCsrfToken(null);
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        register,
        verifyEmail,
        resendVerification,
        refreshUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

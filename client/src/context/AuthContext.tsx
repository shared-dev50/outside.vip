import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { api } from '../lib/api';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { email: string; password: string; name: string; role?: string; organizerDisplayName?: string }) => Promise<void>;
  logout: () => void;
  quickLoginAs: (role: 'organizer' | 'attendee' | 'admin') => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('outside_token'));
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    async function loadUser() {
      const storedToken = localStorage.getItem('outside_token');
      if (!storedToken) {
        setIsLoading(false);
        return;
      }

      try {
        const { user: fetchedUser } = await api.auth.me();
        setUser(fetchedUser);
      } catch (err) {
        console.warn('Session expired or invalid, logging out', err);
        localStorage.removeItem('outside_token');
        setToken(null);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    }

    loadUser();
  }, []);

  const login = async (email: string, password: string) => {
    const data = await api.auth.login({ email, password });
    localStorage.setItem('outside_token', data.token);
    setToken(data.token);
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
    localStorage.setItem('outside_token', data.token);
    setToken(data.token);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem('outside_token');
    setToken(null);
    setUser(null);
  };

  const quickLoginAs = async (role: 'organizer' | 'attendee' | 'admin') => {
    if (role === 'organizer') {
      await login('sol@outside.vip', 'Outside2026!');
    } else if (role === 'admin') {
      await login('admin@outside.vip', 'Outside2026!');
    } else {
      await login('alex@outside.vip', 'Outside2026!');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        login,
        register,
        logout,
        quickLoginAs,
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

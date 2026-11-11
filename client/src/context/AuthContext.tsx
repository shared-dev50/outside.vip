import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { api } from '../lib/api';

interface AuthContextType {
  user: User | null;
  token: string | null;
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
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('outside_token'));
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshUser = async (): Promise<User | null> => {
    const storedToken = localStorage.getItem('outside_token');
    if (!storedToken) {
      setUser(null);
      return null;
    }
    try {
      const { user: fetchedUser } = await api.auth.me();
      setUser(fetchedUser);
      return fetchedUser;
    } catch (err) {
      console.warn('Session expired or invalid, logging out', err);
      localStorage.removeItem('outside_token');
      setToken(null);
      setUser(null);
      return null;
    }
  };

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

  const verifyEmail = async (code: string): Promise<User> => {
    const data = await api.auth.verifyEmail({ code });
    localStorage.setItem('outside_token', data.token);
    setToken(data.token);
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

  const logout = () => {
    localStorage.removeItem('outside_token');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
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

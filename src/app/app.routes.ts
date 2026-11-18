import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { ApiService } from './core/services/api.service';
import type { Section } from '../shared/api.types';

/**
 * Keep non-admins off the admin pages. The server refuses the data anyway;
 * this just sends them home instead of an empty screen full of errors.
 */
const adminOnly: CanActivateFn = async () => {
  const api = inject(ApiService);
  const router = inject(Router);
  // Signed out: let the route through — the shell shows the login screen
  // instead of the page, and the role is checked again after sign-in.
  if (!(await api.whenReady())) return true;
  return api.isAdmin() || router.parseUrl(api.homePath());
};

/** Keep accounts off sections their access role doesn't open. */
const section =
  (id: Section): CanActivateFn =>
  async () => {
    const api = inject(ApiService);
    const router = inject(Router);
    if (!(await api.whenReady())) return true;
    return api.can(id) || router.parseUrl(api.homePath());
  };

/** "Доступы": the head of buying, and team leads for their own teams. */
const grantsGuard: CanActivateFn = async () => {
  const api = inject(ApiService);
  const router = inject(Router);
  if (!(await api.whenReady())) return true;
  return api.canGrants() || router.parseUrl(api.homePath());
};

const home: CanActivateFn = async () => {
  const api = inject(ApiService);
  const router = inject(Router);
  await api.whenReady();
  return router.parseUrl(api.homePath());
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [home], children: [] },
  {
    path: 'library',
    canActivate: [section('library')],
    loadComponent: () => import('./pages/library/library').then((m) => m.LibraryPage),
    title: 'Библиотека крео',
  },
  {
    path: 'quality',
    canActivate: [section('quality')],
    loadComponent: () => import('./pages/quality/quality').then((m) => m.QualityPage),
    title: 'Качество видео на лендах',
  },
  {
    path: 'quality/:id',
    canActivate: [section('quality')],
    loadComponent: () =>
      import('./pages/quality/quality-detail').then((m) => m.QualityDetailPage),
    title: 'Видео на ленде',
  },
  {
    path: 'users',
    canActivate: [adminOnly],
    loadComponent: () => import('./pages/users/users').then((m) => m.UsersPage),
    title: 'Пользователи',
  },
  {
    path: 'caps',
    canActivate: [section('caps')],
    loadComponent: () => import('./pages/caps/caps').then((m) => m.CapsPage),
    title: 'Капы',
  },
  {
    path: 'domains',
    canActivate: [section('domains')],
    loadComponent: () => import('./pages/domains/domains').then((m) => m.DomainsPage),
    title: 'Домены',
  },
  {
    path: 'dashboard',
    canActivate: [adminOnly],
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage),
    title: 'Дашборд',
  },
  {
    path: 'grants',
    canActivate: [grantsGuard],
    loadComponent: () => import('./pages/grants/grants').then((m) => m.GrantsPage),
    title: 'Доступы',
  },
  {
    path: 'history',
    canActivate: [section('history')],
    loadComponent: () => import('./pages/history/history').then((m) => m.HistoryPage),
    title: 'История загрузок',
  },
  {
    path: 'verticals',
    canActivate: [adminOnly],
    loadComponent: () => import('./pages/verticals/verticals').then((m) => m.VerticalsPage),
    title: 'Вертикали',
  },
  {
    path: 'apifb',
    canActivate: [adminOnly],
    loadComponent: () => import('./pages/apifb/apifb').then((m) => m.ApifbPage),
    title: 'Тест Facebook',
  },
  {
    path: 'notifications',
    loadComponent: () => import('./pages/notifications/notifications').then((m) => m.NotificationsPage),
    title: 'Уведомления',
  },
  {
    path: 'offers',
    canActivate: [section('offers')],
    loadComponent: () => import('./pages/offers/offers').then((m) => m.OffersPage),
    title: 'Офферы',
  },
  {
    path: 'knowledge',
    canActivate: [section('knowledge')],
    loadComponent: () => import('./pages/knowledge/knowledge').then((m) => m.KnowledgePage),
    title: 'База знаний',
  },
  {
    path: 'knowledge/:id',
    canActivate: [section('knowledge')],
    loadComponent: () => import('./pages/knowledge/knowledge-doc').then((m) => m.KnowledgeDocPage),
    title: 'База знаний',
  },
  { path: '**', canActivate: [home], children: [] },
];

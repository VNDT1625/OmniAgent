import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLoader from '@renderer/components/layout/AppLoader';
import RouteErrorBoundary from '@renderer/components/layout/RouteErrorBoundary';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { MUSIC_STUDIO_ENABLED, TEAM_MODE_ENABLED } from '@/common/config/constants';
const Conversation = React.lazy(() => import('@renderer/pages/conversation'));
const Guid = React.lazy(() => import('@renderer/pages/guid'));
const Studio = React.lazy(() => import('@renderer/pages/studio'));
const Manager = React.lazy(() => import('@renderer/pages/manager'));
const AgentSettings = React.lazy(() => import('@renderer/pages/settings/AgentSettings'));
const AssistantSettings = React.lazy(() => import('@renderer/pages/settings/AssistantSettings'));
const CapabilitiesSettings = React.lazy(() => import('@renderer/pages/settings/CapabilitiesSettings'));
const DisplaySettings = React.lazy(() => import('@renderer/pages/settings/DisplaySettings'));
const ModeSettings = React.lazy(() => import('@renderer/pages/settings/ModeSettings'));
const SystemSettings = React.lazy(() => import('@renderer/pages/settings/SystemSettings'));
const WebuiSettings = React.lazy(() => import('@renderer/pages/settings/WebuiSettings'));
const PetSettings = React.lazy(() => import('@renderer/pages/settings/PetSettings'));
const ResourceSettings = React.lazy(() => import('@renderer/pages/settings/ResourceSettings'));
const CompanySettings = React.lazy(() => import('@renderer/pages/company'));
const RealtimeKnowledgeSettings = React.lazy(() => import('@renderer/pages/knowledge'));
const BrowserSettings = React.lazy(() => import('@renderer/pages/browser'));
const TestingSettings = React.lazy(() => import('@renderer/pages/testing'));
const MonitorSettings = React.lazy(() => import('@renderer/pages/monitor'));
const TerminalSettings = React.lazy(() => import('@renderer/pages/terminal'));
const GitSettings = React.lazy(() => import('@renderer/pages/git'));
const NewsSettings = React.lazy(() => import('@renderer/pages/news'));
const ExtensionSettingsPage = React.lazy(() => import('@renderer/pages/settings/ExtensionSettingsPage'));
const LoginPage = React.lazy(() => import('@renderer/pages/login'));
const ComponentsShowcase = React.lazy(() => import('@renderer/pages/TestShowcase'));
const ScheduledTasksPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage'));
const TaskDetailPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage/TaskDetailPage'));
const TeamIndex = React.lazy(() => import('@renderer/pages/team'));

const withRouteFallback = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <RouteErrorBoundary>
    <Suspense fallback={<AppLoader />}>
      <Component />
    </Suspense>
  </RouteErrorBoundary>
);

const ProtectedLayout: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status } = useAuth();

  if (status === 'checking') {
    return <AppLoader />;
  }

  if (status !== 'authenticated') {
    return <Navigate to='/login' replace />;
  }

  return React.cloneElement(layout);
};

const PanelRoute: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status } = useAuth();

  return (
    <HashRouter>
      <Routes>
        <Route
          path='/login'
          element={status === 'authenticated' ? <Navigate to='/guid' replace /> : withRouteFallback(LoginPage)}
        />
        <Route element={<ProtectedLayout layout={layout} />}>
          <Route index element={<Navigate to='/guid' replace />} />
          <Route path='/guid' element={withRouteFallback(Guid)} />
          <Route path='/studio' element={withRouteFallback(Studio)} />
          <Route path='/manager' element={withRouteFallback(Manager)} />
          <Route path='/conversation/:id' element={withRouteFallback(Conversation)} />
          <Route
            path='/team/:id'
            element={TEAM_MODE_ENABLED ? withRouteFallback(TeamIndex) : <Navigate to='/guid' replace />}
          />
          <Route
            path='/music'
            element={
              MUSIC_STUDIO_ENABLED ? (
                <Navigate to='/studio' replace state={{ studioView: 'music' }} />
              ) : (
                <Navigate to='/guid' replace />
              )
            }
          />
          <Route path='/settings/model' element={withRouteFallback(ModeSettings)} />
          <Route path='/settings/assistants' element={withRouteFallback(AssistantSettings)} />
          <Route path='/settings/agent' element={withRouteFallback(AgentSettings)} />
          <Route path='/settings/capabilities' element={withRouteFallback(CapabilitiesSettings)} />
          {/* Legacy routes — redirect to the merged /settings/capabilities page */}
          <Route path='/settings/skills-hub' element={<Navigate to='/settings/capabilities?tab=skills' replace />} />
          <Route path='/settings/tools' element={<Navigate to='/settings/capabilities?tab=tools' replace />} />
          <Route path='/settings/display' element={withRouteFallback(DisplaySettings)} />
          <Route path='/settings/webui' element={withRouteFallback(WebuiSettings)} />
          <Route path='/settings/pet' element={withRouteFallback(PetSettings)} />
          <Route path='/settings/resource' element={withRouteFallback(ResourceSettings)} />
          <Route path='/settings/company' element={withRouteFallback(CompanySettings)} />
          <Route path='/settings/knowledge' element={withRouteFallback(RealtimeKnowledgeSettings)} />
          <Route path='/settings/browser' element={withRouteFallback(BrowserSettings)} />
          <Route path='/settings/testing' element={withRouteFallback(TestingSettings)} />
          <Route path='/settings/monitor' element={withRouteFallback(MonitorSettings)} />
          <Route path='/settings/terminal' element={withRouteFallback(TerminalSettings)} />
          <Route path='/settings/git' element={withRouteFallback(GitSettings)} />
          <Route path='/settings/realtime' element={withRouteFallback(NewsSettings)} />
          {/* Legacy redirect for old /settings/news bookmarks */}
          <Route path='/settings/news' element={<Navigate to='/settings/realtime' replace />} />
          <Route path='/settings/system' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/about' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/ext/:tabId' element={withRouteFallback(ExtensionSettingsPage)} />
          <Route path='/settings' element={<Navigate to='/settings/model' replace />} />
          <Route path='/test/components' element={withRouteFallback(ComponentsShowcase)} />
          <Route path='/scheduled' element={withRouteFallback(ScheduledTasksPage)} />
          <Route path='/scheduled/:job_id' element={withRouteFallback(TaskDetailPage)} />
        </Route>
        <Route path='*' element={<Navigate to={status === 'authenticated' ? '/guid' : '/login'} replace />} />
      </Routes>
    </HashRouter>
  );
};

export default PanelRoute;

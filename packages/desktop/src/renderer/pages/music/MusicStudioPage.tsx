/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Music Studio — DAW canvas layout backed by @aionui/music-core.
 *
 * This intentionally follows the working shape of FL Studio / BandLab /
 * Cakewalk: persistent transport, browser, track headers, playlist, inspector,
 * and a bottom dock for mixer/channel rack/piano roll/record/tune. The layout
 * is responsive: side docks collapse away first so the playlist remains usable
 * on smaller app windows.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Empty, Message, Slider, Space, Tag, Typography } from '@arco-design/web-react';
import {
  Download,
  HeadphoneSound,
  Left,
  Lightning,
  MagicWand,
  MusicOne,
  Pause,
  Play,
  Save,
  VoiceOne,
  VolumeMute,
} from '@icon-park/react';
import { ipcBridge } from '@/common';
import {
  addAudioClip,
  addEffect,
  addNote,
  addPatternClip,
  addTrack,
  assignSampler,
  createProject,
  layProgression,
  setStep,
  setTempo,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
  suggestProgression,
  type Clip,
  type Project,
  type ProjectSummary,
  type Sample,
  type Track,
  type TrackType,
} from '@aionui/music-core';
import { useMusicPlayer } from './useMusicPlayer';
import { musicClient } from './musicClient';

type MusicStudioPageProps = {
  onBack?: () => void;
};

type DockView = 'mixer' | 'channelRack' | 'pianoRoll' | 'recorder' | 'tune' | 'browser' | 'producer';
type MusicResult<T> = { ok: true; data: T } | { ok: false; error: string };

const KICK_SAMPLE: Sample = {
  id: 'kick',
  file: 'samples/kick.wav',
  name: 'Kick',
  durationSec: 0.18,
  sampleRate: 48000,
};

const DOCKS: DockView[] = ['mixer', 'channelRack', 'pianoRoll', 'recorder', 'tune', 'browser', 'producer'];

function unwrap<T>(result: MusicResult<T>): T {
  if ('data' in result) return result.data;
  throw new Error(result.error);
}

function buildDemoProject(): Project {
  let project = createProject('Demo Song');
  project = setTempo(project, 90);
  project = { ...project, samples: [KICK_SAMPLE] };

  const drums = addTrack(project, 'Drums');
  project = drums.project;
  project = assignSampler(project, drums.trackId, KICK_SAMPLE.id);
  const drumClip = addPatternClip(project, drums.trackId, 0, 4);
  project = drumClip.project;
  for (const step of [0, 3, 6, 10, 12]) {
    project = setStep(project, drums.trackId, drumClip.clipId, step, KICK_SAMPLE.id, 118);
  }

  const keys = addTrack(project, 'Keys', 'midi');
  project = keys.project;
  const keysClipId = 'keys-clip';
  project = {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === keys.trackId
        ? { ...track, clips: [{ id: keysClipId, startBeat: 0, lengthBeat: 16, kind: 'midi' as const, notes: [] }] }
        : track
    ),
  };
  return layProgression(project, keys.trackId, keysClipId, suggestProgression(9, 'minor'), { beatsPerChord: 4 });
}

const MusicStudioPage: React.FC<MusicStudioPageProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const player = useMusicPlayer();
  const [project, setProject] = useState<Project>(() => createProject('Untitled'));
  const [savedPath, setSavedPath] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>(undefined);
  const [activeDock, setActiveDock] = useState<DockView>('mixer');
  const [busy, setBusy] = useState(false);

  const selectedTrack = useMemo(
    () => project.tracks.find((track) => track.id === selectedTrackId) ?? project.tracks[0],
    [project.tracks, selectedTrackId]
  );
  const beatClip = useMemo(() => findPatternClip(selectedTrack), [selectedTrack]);
  const midiClip = useMemo(() => findMidiClip(selectedTrack), [selectedTrack]);
  const progression = useMemo(() => suggestProgression(9, 'minor').map((chord) => chord.name), []);
  const isEmpty = project.tracks.length === 0;

  useEffect(() => {
    void refreshProjects();
  }, []);

  const refreshProjects = async (): Promise<void> => {
    try {
      setProjects(unwrap(await musicClient.list()));
    } catch (error) {
      Message.error(String((error as Error).message));
    }
  };

  const ensureProjectPath = async (): Promise<string> => {
    if (savedPath) return savedPath;
    const created = unwrap(await musicClient.create(project.name || 'Untitled'));
    setSavedPath(created.path);
    await refreshProjects();
    return created.path;
  };

  const handleCreateProject = async (): Promise<void> => {
    setBusy(true);
    try {
      const created = unwrap(await musicClient.create('Untitled'));
      setProject(created.project);
      setSavedPath(created.path);
      setSelectedTrackId(undefined);
      await refreshProjects();
    } catch (error) {
      Message.error(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenProject = async (path: string): Promise<void> => {
    setBusy(true);
    try {
      const opened = unwrap(await musicClient.open(path));
      setProject(opened);
      setSavedPath(path);
      setSelectedTrackId(opened.tracks[0]?.id);
    } catch (error) {
      Message.error(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await ensureProjectPath();
      unwrap(await musicClient.save(path, project));
      Message.success(t('music.msg.saved'));
      await refreshProjects();
    } catch (error) {
      Message.error(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await ensureProjectPath();
      unwrap(await musicClient.save(path, project));
      const rendered = unwrap(await musicClient.render(path, project, true));
      Message.success(t('music.msg.exported', { path: rendered.mixPath }));
    } catch (error) {
      Message.error(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const handlePlay = async (): Promise<void> => {
    try {
      if (player.state === 'playing') {
        player.stop();
      } else {
        await player.play(project, savedPath);
      }
    } catch (error) {
      Message.error(String((error as Error).message));
    }
  };

  const handleLoadDemo = (): void => {
    const demo = buildDemoProject();
    setProject(demo);
    setSelectedTrackId(demo.tracks[0]?.id);
  };

  const handleAddTrack = (type: TrackType): void => {
    const result = addTrack(project, t(`music.trackType.${type}`), type);
    setProject(result.project);
    setSelectedTrackId(result.trackId);
  };

  const handleImportWav = async (): Promise<void> => {
    setBusy(true);
    try {
      const picked = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile'],
        filters: [{ name: 'WAV', extensions: ['wav'] }],
      });
      const sourcePath = picked?.[0];
      if (!sourcePath) return;

      const path = await ensureProjectPath();
      const sample = unwrap(await musicClient.importSample(path, sourcePath));
      let next: Project = { ...project, samples: [...project.samples, sample] };
      let trackId = selectedTrack?.type === 'audio' ? selectedTrack.id : undefined;
      if (!trackId) {
        const created = addTrack(next, sample.name, 'audio');
        next = created.project;
        trackId = created.trackId;
      }
      const lengthBeat = Math.max(1, Math.ceil((sample.durationSec * project.tempo) / 60));
      next = addAudioClip(next, trackId, sample.id, 0, lengthBeat).project;
      setProject(next);
      setSelectedTrackId(trackId);
      unwrap(await musicClient.save(path, next));
      Message.success(t('music.msg.sampleImported'));
    } catch (error) {
      Message.error(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const handleAddPattern = (): void => {
    if (!selectedTrack) return;
    const prepared = ensureKickSample(project);
    const withSampler =
      selectedTrack.type === 'instrument' ? assignSampler(prepared, selectedTrack.id, KICK_SAMPLE.id) : prepared;
    setProject(addPatternClip(withSampler, selectedTrack.id, 0, 4).project);
  };

  const handleToggleStep = (step: number): void => {
    if (!selectedTrack) return;
    const prepared = ensureTrackPattern(project, selectedTrack);
    const track = prepared.tracks.find((candidate) => candidate.id === selectedTrack.id);
    const clip = findPatternClip(track);
    if (!track || !clip) return;
    const active = Boolean(clip.steps?.some((item) => item.step === step && item.velocity > 0));
    setProject(setStep(prepared, track.id, clip.id, step, KICK_SAMPLE.id, active ? 0 : 112));
  };

  const handleAddChord = (): void => {
    if (!selectedTrack) return;
    const prepared = ensureMidiClip(project, selectedTrack);
    const track = prepared.tracks.find((candidate) => candidate.id === selectedTrack.id);
    const clip = findMidiClip(track);
    if (!track || !clip) return;
    let next = prepared;
    for (const pitch of [57, 60, 64]) {
      next = addNote(next, track.id, clip.id, { pitch, startBeat: 0, lengthBeat: 4, velocity: 92 });
    }
    setProject(next);
  };

  return (
    <div className='size-full min-h-0 overflow-hidden bg-1 flex flex-col'>
      <DawTopBar
        onBack={onBack}
        project={project}
        savedPath={savedPath}
        busy={busy}
        playerState={player.state}
        isEmpty={isEmpty}
        onTempoChange={(tempo) => setProject(setTempo(project, tempo))}
        onPlay={() => void handlePlay()}
        onSave={() => void handleSave()}
        onExport={() => void handleExport()}
        onRecord={() => setActiveDock('recorder')}
      />

      <div className='flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[176px_minmax(0,1fr)]'>
        <div className='hidden lg:block min-h-0 border-r border-b-1'>
          <TrackHeaderPanel
            project={project}
            selectedTrackId={selectedTrack?.id}
            onSelectTrack={setSelectedTrackId}
            onMute={(track) => setProject(setTrackMute(project, track.id, !track.mute))}
            onSolo={(track) => setProject(setTrackSolo(project, track.id, !track.solo))}
          />
        </div>

        <PlaylistPanel
          project={project}
          selectedTrackId={selectedTrack?.id}
          onLoadDemo={handleLoadDemo}
          onAddTrack={handleAddTrack}
          onSelectTrack={setSelectedTrackId}
        />
      </div>

      <BottomDock
        activeDock={activeDock}
        setActiveDock={setActiveDock}
        project={project}
        selectedTrack={selectedTrack}
        selectedTrackId={selectedTrack?.id}
        beatClip={beatClip}
        midiClip={midiClip}
        busy={busy}
        projects={projects}
        savedPath={savedPath}
        progression={progression}
        onAddTrack={handleAddTrack}
        onSelectTrack={setSelectedTrackId}
        onVolume={(trackId, value) => !Array.isArray(value) && setProject(setTrackVolume(project, trackId, value))}
        onPan={(trackId, value) => !Array.isArray(value) && setProject(setTrackPan(project, trackId, value / 100))}
        onMute={(track) => setProject(setTrackMute(project, track.id, !track.mute))}
        onSolo={(track) => setProject(setTrackSolo(project, track.id, !track.solo))}
        onAddEq={(track) => setProject(addEffect(project, track.id, 'eq3').project)}
        onAddPattern={handleAddPattern}
        onToggleStep={handleToggleStep}
        onAddChord={handleAddChord}
        onLoadDemo={handleLoadDemo}
        onCreate={() => void handleCreateProject()}
        onRefresh={() => void refreshProjects()}
        onOpenProject={(path) => void handleOpenProject(path)}
        onImportWav={() => void handleImportWav()}
      />
    </div>
  );
};

const DawTopBar: React.FC<{
  onBack?: () => void;
  project: Project;
  savedPath?: string;
  busy: boolean;
  playerState: 'stopped' | 'playing';
  isEmpty: boolean;
  onTempoChange: (tempo: number) => void;
  onPlay: () => void;
  onSave: () => void;
  onExport: () => void;
  onRecord: () => void;
}> = ({
  onBack,
  project,
  savedPath,
  busy,
  playerState,
  isEmpty,
  onTempoChange,
  onPlay,
  onSave,
  onExport,
  onRecord,
}) => {
  const { t } = useTranslation();
  return (
    <header className='shrink-0 border-b border-b-1 bg-2'>
      <div className='h-28px px-10px flex items-center gap-14px text-12px text-t-secondary border-b border-b-1'>
        <Typography.Text className='font-[600] text-t-primary'>{t('music.title')}</Typography.Text>
        <Typography.Text>{t('music.menu.file')}</Typography.Text>
        <Typography.Text>{t('music.menu.edit')}</Typography.Text>
        <Typography.Text>{t('music.menu.track')}</Typography.Text>
        <Typography.Text>{t('music.menu.tools')}</Typography.Text>
        <Typography.Text>{t('music.views.producer')}</Typography.Text>
      </div>
      <div className='min-h-52px px-10px py-6px flex flex-wrap items-center gap-8px'>
        {onBack ? <Button icon={<Left theme='outline' />} onClick={onBack} /> : null}
        <div className='size-32px rd-6px bg-fill-2 flex-center'>
          <MusicOne theme='outline' size='18' />
        </div>
        <div className='min-w-120px max-w-220px'>
          <Typography.Text className='block font-[600]'>{project.name}</Typography.Text>
          <Typography.Text type='secondary' className='block text-12px truncate'>
            {savedPath ?? t('music.project.unsaved')}
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<Play theme='outline' />} disabled={isEmpty || playerState === 'playing'} onClick={onPlay} />
          <Button icon={<Pause theme='outline' />} disabled={playerState !== 'playing'} onClick={onPlay} />
          <Button type='primary' icon={<VoiceOne theme='outline' />} onClick={onRecord}>
            {t('music.action.record')}
          </Button>
        </Space>
        <div className='w-130px'>
          <Typography.Text type='secondary' className='text-11px'>
            {t('music.project.tempo')}
          </Typography.Text>
          <Slider
            value={project.tempo}
            min={60}
            max={180}
            onChange={(value) => !Array.isArray(value) && onTempoChange(value)}
          />
        </div>
        <Tag>{t('music.value.bpm', { tempo: project.tempo })}</Tag>
        <Tag>{project.timeSignature.join('/')}</Tag>
        <Tag>{t('music.value.keyAMinor')}</Tag>
        <Tag>{t('music.transport.snap')}</Tag>
        <div className='flex-1' />
        <Button icon={<Save theme='outline' />} loading={busy} onClick={onSave}>
          {t('music.action.save')}
        </Button>
        <Button icon={<Download theme='outline' />} loading={busy} disabled={isEmpty} onClick={onExport}>
          {t('music.action.export')}
        </Button>
      </div>
    </header>
  );
};

const BrowserPanel: React.FC<{
  busy: boolean;
  project: Project;
  projects: ProjectSummary[];
  savedPath?: string;
  onCreate: () => void;
  onRefresh: () => void;
  onOpenProject: (path: string) => void;
  onImportWav: () => void;
}> = ({ busy, project, projects, savedPath, onCreate, onRefresh, onOpenProject, onImportWav }) => {
  const { t } = useTranslation();
  return (
    <div className='size-full min-h-0 bg-1 flex flex-col'>
      <PanelTitle
        title={t('music.views.browser')}
        action={t('music.browser.importWav')}
        onAction={onImportWav}
        busy={busy}
      />
      <div className='flex-1 min-h-0 overflow-auto p-10px flex flex-col gap-12px'>
        <Card size='small' title={t('music.views.projects')}>
          <Space className='mb-10px' wrap>
            <Button size='small' onClick={onCreate}>
              {t('music.projects.new')}
            </Button>
            <Button size='small' onClick={onRefresh}>
              {t('music.projects.refresh')}
            </Button>
          </Space>
          <div className='flex flex-col gap-6px'>
            {projects.slice(0, 5).map((item) => (
              <Button
                key={item.path}
                long
                size='small'
                type={item.path === savedPath ? 'primary' : 'secondary'}
                onClick={() => onOpenProject(item.path)}
              >
                {item.name}
              </Button>
            ))}
            {projects.length === 0 ? (
              <Typography.Text type='secondary'>{t('music.projects.empty')}</Typography.Text>
            ) : null}
          </div>
        </Card>
        <Card size='small' title={t('music.browser.samples')}>
          {project.samples.length === 0 ? (
            <Empty description={t('music.browser.empty')} />
          ) : (
            <div className='flex flex-col gap-6px'>
              {project.samples.map((sample) => (
                <div key={sample.id} className='rd-6px bg-fill-1 px-8px py-6px'>
                  <Typography.Text className='block text-12px'>{sample.name}</Typography.Text>
                  <Typography.Text type='secondary' className='block text-11px truncate'>
                    {sample.file}
                  </Typography.Text>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

const TrackHeaderPanel: React.FC<{
  project: Project;
  selectedTrackId?: string;
  onSelectTrack: (id: string) => void;
  onMute: (track: Track) => void;
  onSolo: (track: Track) => void;
}> = ({ project, selectedTrackId, onSelectTrack, onMute, onSolo }) => {
  const { t } = useTranslation();
  return (
    <div className='size-full min-h-0 bg-1 grid grid-rows-[34px_30px_minmax(0,1fr)]'>
      <div className='h-34px px-10px border-b border-b-1 bg-2 flex items-center'>
        <Typography.Text className='font-[600]'>{t('music.trackHeaders.title')}</Typography.Text>
      </div>
      <div className='h-30px border-b border-b-1 bg-fill-1' />
      <div className='flex-1 min-h-0 overflow-auto'>
        {project.tracks.map((track) => (
          <div
            key={track.id}
            className={`h-56px border-b border-b-1 px-6px py-5px grid grid-cols-[minmax(0,1fr)_30px] gap-6px ${track.id === selectedTrackId ? 'bg-fill-2' : ''}`}
          >
            <div className='min-w-0'>
              <Button
                size='small'
                long
                className='!h-24px !justify-start !px-6px'
                type={track.id === selectedTrackId ? 'primary' : 'secondary'}
                onClick={() => onSelectTrack(track.id)}
              >
                {track.name}
              </Button>
              <Typography.Text type='secondary' className='block mt-3px text-11px truncate'>
                {t(`music.trackType.${track.type}`)}
              </Typography.Text>
            </div>
            <div className='flex flex-col gap-2px'>
              <Button
                size='mini'
                className='!h-20px !w-28px !px-0'
                icon={<VolumeMute theme='outline' />}
                type={track.mute ? 'primary' : 'secondary'}
                onClick={() => onMute(track)}
              />
              <Button
                size='mini'
                className='!h-20px !w-28px !px-0'
                icon={<HeadphoneSound theme='outline' />}
                type={track.solo ? 'primary' : 'secondary'}
                onClick={() => onSolo(track)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PlaylistPanel: React.FC<{
  project: Project;
  selectedTrackId?: string;
  onLoadDemo: () => void;
  onAddTrack: (type: TrackType) => void;
  onSelectTrack: (id: string) => void;
}> = ({ project, selectedTrackId, onLoadDemo, onAddTrack, onSelectTrack }) => {
  const { t } = useTranslation();
  const bars = Array.from({ length: 16 }, (_, index) => index + 1);
  return (
    <section className='min-w-0 min-h-0 bg-1 grid grid-rows-[34px_minmax(0,1fr)]'>
      <div className='h-34px border-b border-b-1 bg-2 flex items-center gap-6px px-8px overflow-x-auto'>
        <Button size='small' type='primary' onClick={onLoadDemo}>
          {t('music.action.buildDemo')}
        </Button>
        <Button size='small' onClick={() => onAddTrack('instrument')}>
          {t('music.action.addInstrument')}
        </Button>
        <Button size='small' onClick={() => onAddTrack('audio')}>
          {t('music.action.addAudio')}
        </Button>
        <Button size='small' onClick={() => onAddTrack('midi')}>
          {t('music.action.addMidi')}
        </Button>
        <div className='flex-1' />
        <Tag>{t('music.transport.barBeat', { bar: 1, beat: 1 })}</Tag>
      </div>
      <div className='min-h-0 overflow-auto'>
        <div className='min-w-760px'>
          <div className='h-30px grid grid-cols-16 border-b border-b-1 bg-fill-1'>
            {bars.map((bar) => (
              <div key={bar} className='border-r border-b-1 px-6px pt-6px text-11px text-t-secondary'>
                {bar}
              </div>
            ))}
          </div>
          {project.tracks.length === 0 ? (
            <div className='h-220px flex-center flex-col gap-10px'>
              <Empty description={t('music.tracks.empty')} />
              <Button type='primary' onClick={onLoadDemo}>
                {t('music.action.buildDemo')}
              </Button>
            </div>
          ) : null}
          {project.tracks.map((track) => (
            <div
              key={track.id}
              className={`h-56px grid grid-cols-[118px_1fr] lg:grid-cols-[0_1fr] border-b border-b-1 ${track.id === selectedTrackId ? 'bg-fill-1' : ''}`}
            >
              <Button
                className='!h-full !justify-start !rd-0 lg:!hidden'
                type={track.id === selectedTrackId ? 'primary' : 'secondary'}
                onClick={() => onSelectTrack(track.id)}
              >
                {track.name}
              </Button>
              <div className='relative bg-[linear-gradient(to_right,var(--color-border-2)_1px,transparent_1px)] bg-[length:56px_100%]'>
                {track.clips.map((clip) => (
                  <ClipBlock key={clip.id} clip={clip} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const ClipBlock: React.FC<{ clip: Clip }> = ({ clip }) => {
  const { t } = useTranslation();
  const left = Math.max(0, clip.startBeat * 14);
  const width = Math.max(70, clip.lengthBeat * 42);
  const clipClass =
    clip.kind === 'audio'
      ? 'bg-primary-light-2 text-primary'
      : clip.kind === 'midi'
        ? 'bg-warning-light-2 text-warning'
        : 'bg-success-light-2 text-success';
  return (
    <div
      className={`absolute top-7px h-40px rd-5px border border-b-1 px-8px py-4px overflow-hidden ${clipClass}`}
      style={{ left, width }}
    >
      <Typography.Text className='block text-12px font-[500]'>{t(`music.clipKind.${clip.kind}`)}</Typography.Text>
      <div className='mt-5px h-10px bg-current opacity-35 rd-4px' />
    </div>
  );
};

const BottomDock: React.FC<{
  activeDock: DockView;
  setActiveDock: (dock: DockView) => void;
  project: Project;
  selectedTrack?: Track;
  selectedTrackId?: string;
  beatClip?: Clip;
  midiClip?: Clip;
  busy: boolean;
  projects: ProjectSummary[];
  savedPath?: string;
  progression: string[];
  onAddTrack: (type: TrackType) => void;
  onSelectTrack: (id: string) => void;
  onVolume: (id: string, value: number | number[]) => void;
  onPan: (id: string, value: number | number[]) => void;
  onMute: (track: Track) => void;
  onSolo: (track: Track) => void;
  onAddEq: (track: Track) => void;
  onAddPattern: () => void;
  onToggleStep: (step: number) => void;
  onAddChord: () => void;
  onLoadDemo: () => void;
  onCreate: () => void;
  onRefresh: () => void;
  onOpenProject: (path: string) => void;
  onImportWav: () => void;
}> = (props) => {
  const { t } = useTranslation();
  return (
    <section className='shrink-0 h-260px sm:h-286px border-t border-b-1 bg-2 grid grid-rows-[32px_minmax(0,1fr)]'>
      <div className='h-32px px-8px flex items-center gap-5px overflow-x-auto border-b border-b-1'>
        {DOCKS.map((dock) => (
          <Button
            key={dock}
            size='mini'
            type={props.activeDock === dock ? 'primary' : 'secondary'}
            onClick={() => props.setActiveDock(dock)}
          >
            {t(`music.dock.${dock}`)}
          </Button>
        ))}
      </div>
      <div className='min-h-0 overflow-auto p-8px'>
        {props.activeDock === 'mixer' ? <MixerDock {...props} /> : null}
        {props.activeDock === 'channelRack' ? <ChannelRackDock {...props} /> : null}
        {props.activeDock === 'pianoRoll' ? <PianoRollDock {...props} /> : null}
        {props.activeDock === 'recorder' ? <RecorderDock onAddAudio={() => props.onAddTrack('audio')} /> : null}
        {props.activeDock === 'tune' ? <TuneDock selectedTrack={props.selectedTrack} /> : null}
        {props.activeDock === 'browser' ? (
          <BrowserPanel
            busy={props.busy}
            project={props.project}
            projects={props.projects}
            savedPath={props.savedPath}
            onCreate={props.onCreate}
            onRefresh={props.onRefresh}
            onOpenProject={props.onOpenProject}
            onImportWav={props.onImportWav}
          />
        ) : null}
        {props.activeDock === 'producer' ? (
          <ProducerDock selectedTrack={props.selectedTrack} progression={props.progression} />
        ) : null}
      </div>
    </section>
  );
};

const MixerDock: React.FC<{
  project: Project;
  selectedTrackId?: string;
  onSelectTrack: (id: string) => void;
  onVolume: (id: string, value: number | number[]) => void;
  onPan: (id: string, value: number | number[]) => void;
  onMute: (track: Track) => void;
  onSolo: (track: Track) => void;
  onAddEq: (track: Track) => void;
  onLoadDemo: () => void;
}> = ({ project, selectedTrackId, onSelectTrack, onVolume, onPan, onMute, onSolo, onAddEq, onLoadDemo }) => {
  const { t } = useTranslation();
  if (project.tracks.length === 0) {
    return (
      <div className='h-full flex-center flex-col gap-10px'>
        <Empty description={t('music.tracks.empty')} />
        <Button type='primary' onClick={onLoadDemo}>
          {t('music.action.buildDemo')}
        </Button>
      </div>
    );
  }

  return (
    <div className='grid grid-cols-[repeat(auto-fill,minmax(220px,260px))] gap-8px'>
      {project.tracks.map((track) => (
        <Card
          key={track.id}
          size='small'
          title={track.name}
          className={track.id === selectedTrackId ? 'outline outline-1 outline-primary' : undefined}
        >
          <Space wrap className='mb-6px'>
            <Tag>{t(`music.trackType.${track.type}`)}</Tag>
            <Button
              size='mini'
              type={track.id === selectedTrackId ? 'primary' : 'secondary'}
              onClick={() => onSelectTrack(track.id)}
            >
              {t('music.action.select')}
            </Button>
          </Space>
          <Typography.Text type='secondary' className='block text-11px'>
            {t('music.mixer.volume')}
          </Typography.Text>
          <Slider value={track.volumeDb} min={-60} max={12} onChange={(value) => onVolume(track.id, value)} />
          <Typography.Text type='secondary' className='block text-11px'>
            {t('music.mixer.pan')}
          </Typography.Text>
          <Slider
            value={Math.round(track.pan * 100)}
            min={-100}
            max={100}
            onChange={(value) => onPan(track.id, value)}
          />
          <div className='grid grid-cols-2 gap-6px mb-8px'>
            <Button size='mini' type={track.mute ? 'primary' : 'secondary'} onClick={() => onMute(track)}>
              {t('music.action.mute')}
            </Button>
            <Button size='mini' type={track.solo ? 'primary' : 'secondary'} onClick={() => onSolo(track)}>
              {t('music.action.solo')}
            </Button>
            <Button size='mini' className='col-span-2' onClick={() => onAddEq(track)}>
              {t('music.action.addEq')}
            </Button>
          </div>
          <div className='rd-6px bg-fill-1 p-8px'>
            <Typography.Text className='block text-12px font-[500]'>{t('music.mixer.fxChain')}</Typography.Text>
            <Space wrap className='mt-6px'>
              {track.effects.length === 0 ? <Tag>{t('music.mixer.noFx')}</Tag> : null}
              {track.effects.map((effect) => (
                <Tag key={effect.id}>{effect.kind}</Tag>
              ))}
            </Space>
          </div>
        </Card>
      ))}
    </div>
  );
};

const ChannelRackDock: React.FC<{
  selectedTrack?: Track;
  beatClip?: Clip;
  onAddPattern: () => void;
  onToggleStep: (step: number) => void;
}> = ({ selectedTrack, beatClip, onAddPattern, onToggleStep }) => {
  const { t } = useTranslation();
  return (
    <div>
      <Space className='mb-10px' wrap>
        <Typography.Text className='font-[600]'>{selectedTrack?.name ?? t('music.mixer.noTrack')}</Typography.Text>
        <Button onClick={onAddPattern} disabled={!selectedTrack}>
          {t('music.action.addPattern')}
        </Button>
      </Space>
      <div className='grid grid-cols-8 sm:grid-cols-16 gap-6px'>
        {Array.from({ length: 16 }, (_, index) => (
          <Button
            key={index}
            type={beatClip?.steps?.some((step) => step.step === index && step.velocity > 0) ? 'primary' : 'secondary'}
            disabled={!selectedTrack}
            className='!h-40px !rd-8px'
            onClick={() => onToggleStep(index)}
          >
            {index + 1}
          </Button>
        ))}
      </div>
    </div>
  );
};

const PianoRollDock: React.FC<{
  selectedTrack?: Track;
  midiClip?: Clip;
  onAddTrack: (type: TrackType) => void;
  onAddChord: () => void;
}> = ({ selectedTrack, midiClip, onAddTrack, onAddChord }) => {
  const { t } = useTranslation();
  return (
    <div>
      <Space className='mb-10px' wrap>
        <Typography.Text className='font-[600]'>{selectedTrack?.name ?? t('music.mixer.noTrack')}</Typography.Text>
        <Button onClick={() => onAddTrack('midi')}>{t('music.action.addMidi')}</Button>
        <Button type='primary' disabled={!selectedTrack} onClick={onAddChord}>
          {t('music.pianoRoll.addChord')}
        </Button>
        <Tag>{t('music.pianoRoll.notes', { count: midiClip?.notes?.length ?? 0 })}</Tag>
      </Space>
      <div className='grid grid-cols-[60px_1fr] gap-y-5px'>
        {['C5', 'B4', 'A4', 'G4', 'F4', 'E4', 'D4', 'C4'].map((note) => (
          <React.Fragment key={note}>
            <Typography.Text className='text-12px'>{note}</Typography.Text>
            <div className='h-22px rd-5px bg-fill-1 border border-b-1' />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

const RecorderDock: React.FC<{ onAddAudio: () => void }> = ({ onAddAudio }) => {
  const { t } = useTranslation();
  return (
    <div>
      <Space className='mb-10px'>
        <Button type='primary' icon={<VoiceOne theme='outline' />} disabled>
          {t('music.recording.armInput')}
        </Button>
        <Button onClick={onAddAudio}>{t('music.action.addAudio')}</Button>
        <Tag>{t('music.recording.takeLanes')}</Tag>
      </Space>
      <WaveformPreview />
    </div>
  );
};

const TuneDock: React.FC<{ selectedTrack?: Track }> = ({ selectedTrack }) => {
  const { t } = useTranslation();
  return (
    <div className='grid grid-cols-1 lg:grid-cols-[280px_1fr_280px] gap-12px'>
      <Card size='small' title={selectedTrack?.name ?? t('music.mixer.noTrack')}>
        <MetricRow label={t('music.tuning.key')} value={t('music.value.keyAMinor')} />
        <MetricRow label={t('music.tuning.scale')} value={t('music.value.minor')} />
        <MetricRow label={t('music.tuning.mode')} value={t('music.tuning.naturalMode')} />
      </Card>
      <Card size='small' title={t('music.tuning.correctionPanel')}>
        <Typography.Text type='secondary' className='text-11px'>
          {t('music.tuning.pitchCorrection')}
        </Typography.Text>
        <Slider value={42} disabled />
        <Typography.Text type='secondary' className='text-11px'>
          {t('music.tuning.humanize')}
        </Typography.Text>
        <Slider value={64} disabled />
        <Typography.Text type='secondary' className='text-11px'>
          {t('music.tuning.formant')}
        </Typography.Text>
        <Slider value={50} disabled />
      </Card>
      <Card size='small' title={t('music.tuning.analysis')}>
        <MetricRow label={t('music.tuning.averageShift')} value='18c' />
        <MetricRow label={t('music.tuning.maxShift')} value='47c' />
        <MetricRow label={t('music.tuning.voicedFrames')} value='82%' />
      </Card>
    </div>
  );
};

const ProducerDock: React.FC<{ selectedTrack?: Track; progression: string[] }> = ({ selectedTrack, progression }) => {
  const { t } = useTranslation();
  const tasks = [
    t('music.producer.taskAnalyze'),
    t('music.producer.taskTune'),
    t('music.producer.taskMix'),
    t('music.producer.taskArrange'),
  ];
  return (
    <div className='grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-12px'>
      <Card size='small' title={t('music.producer.title')}>
        <div className='rd-8px bg-fill-1 p-10px mb-10px'>
          <Lightning theme='outline' size='18' />
          <Typography.Text className='ml-8px text-13px'>{t('music.producer.brief')}</Typography.Text>
        </div>
        {tasks.map((task) => (
          <div key={task} className='flex items-center gap-8px mb-8px'>
            <MagicWand theme='outline' size='14' />
            <Typography.Text className='text-13px'>{task}</Typography.Text>
          </div>
        ))}
      </Card>
      <Card size='small' title={selectedTrack?.name ?? t('music.mixer.noTrack')}>
        <Space wrap>
          {progression.map((chord) => (
            <Tag key={chord}>{chord}</Tag>
          ))}
        </Space>
        <Button long className='mt-12px' icon={<MagicWand theme='outline' />} disabled>
          {t('music.producer.ask')}
        </Button>
      </Card>
    </div>
  );
};

const PanelTitle: React.FC<{ title: string; action?: string; busy?: boolean; onAction?: () => void }> = ({
  title,
  action,
  busy,
  onAction,
}) => (
  <div className='h-38px px-10px border-b border-b-1 flex items-center gap-8px'>
    <Typography.Text className='font-[600]'>{title}</Typography.Text>
    <div className='flex-1' />
    {action ? (
      <Button size='mini' loading={busy} onClick={onAction}>
        {action}
      </Button>
    ) : null}
  </div>
);

const MetricRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className='flex items-center gap-8px mb-8px'>
    <Typography.Text type='secondary' className='text-12px'>
      {label}
    </Typography.Text>
    <div className='flex-1' />
    <Typography.Text className='text-12px font-[500] text-right'>{value}</Typography.Text>
  </div>
);

const WaveformPreview: React.FC = () => (
  <div className='h-112px rd-10px bg-fill-2 px-12px flex items-end gap-4px overflow-hidden' aria-hidden='true'>
    {[16, 28, 44, 32, 58, 24, 46, 74, 38, 52, 30, 42, 22, 34, 50, 26, 64, 46, 30, 54, 28, 36].map((height, index) => (
      <div key={`${height}-${index}`} className='flex-1 rd-t-4px bg-fill-4' style={{ height }} />
    ))}
  </div>
);

function findPatternClip(track: Track | undefined): Clip | undefined {
  return track?.clips.find((clip) => clip.kind === 'pattern');
}

function findMidiClip(track: Track | undefined): Clip | undefined {
  return track?.clips.find((clip) => clip.kind === 'midi');
}

function ensureKickSample(project: Project): Project {
  if (project.samples.some((sample) => sample.id === KICK_SAMPLE.id)) return project;
  return { ...project, samples: [...project.samples, KICK_SAMPLE] };
}

function ensureTrackPattern(project: Project, track: Track): Project {
  const prepared = ensureKickSample(project);
  const current = prepared.tracks.find((candidate) => candidate.id === track.id);
  if (findPatternClip(current)) return prepared;
  const withSampler = current?.type === 'instrument' ? assignSampler(prepared, track.id, KICK_SAMPLE.id) : prepared;
  return addPatternClip(withSampler, track.id, 0, 4).project;
}

function ensureMidiClip(project: Project, track: Track): Project {
  const current = project.tracks.find((candidate) => candidate.id === track.id);
  if (findMidiClip(current)) return project;
  const clip: Clip = { id: `midi-${Date.now()}`, startBeat: 0, lengthBeat: 16, kind: 'midi', notes: [] };
  return {
    ...project,
    tracks: project.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, clips: [...candidate.clips, clip] } : candidate
    ),
  };
}

export default MusicStudioPage;

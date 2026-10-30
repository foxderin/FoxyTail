/* Only vite.smoke.config.ts imports this entry; these are real product exports. */
import { ROUTES } from '../src/main';
import * as api from '../src/api';
import * as native from '../src/native';
import * as state from '../src/state';
import * as service from '../src/service';
import * as tasks from '../src/tasks';
import * as files from '../src/files';
import * as backup from '../src/backup';
import * as coexistence from '../src/coexistence';
import * as serve from '../src/serve';
import * as format from '../src/format';
import * as toast from '../src/components/Toast';
import * as confirm from '../src/components/ConfirmDialog';
import { t } from '../src/i18n';
import { applyTheme } from '../src/theme';
import { setLang } from '../src/i18n';
import { createRoot } from 'solid-js';
import * as toolsRefresh from '../src/pages/tools-refresh';
(window as unknown as Record<string, unknown>).__foxy = {
  ROUTES, api, native, state, service, tasks, files, backup, coexistence, serve, format, toast, confirm, t, applyTheme, setLang, createRoot, toolsRefresh,
};

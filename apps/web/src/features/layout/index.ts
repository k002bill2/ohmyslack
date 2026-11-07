/** layout 기능 공개 API(DEV_DESIGN §2-2 B8). */
import './layout.css';

export { AppShell, type AppShellProps } from './AppShell.js';
export { isSidebarCollapsed, readViewport, useViewport, type Breakpoint, type Viewport } from './viewport.js';
export { adjacentSpace, initialShellState, shellReducer, type ShellAction, type ShellState } from './shell-state.js';

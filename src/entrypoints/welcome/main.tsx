import { render } from 'preact';
import { WelcomeApp } from '@/ui/WelcomeApp';
import { createDemoHost } from './demo';

// 入口只做装配：示例文章上的工具栏复用页面侧模块，经 DemoHost 交给界面（界面层不引用 page/）
const root = document.getElementById('app');
if (root) render(<WelcomeApp demo={createDemoHost()} />, root);

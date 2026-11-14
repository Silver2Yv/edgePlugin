import { render } from 'preact';
import { WelcomeApp } from '@/ui/WelcomeApp';

const root = document.getElementById('app');
if (root) render(<WelcomeApp />, root);

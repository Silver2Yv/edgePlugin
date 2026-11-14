import { render } from 'preact';
import { FloatApp } from '@/ui/FloatApp';

const root = document.getElementById('app');
if (root) render(<FloatApp />, root);

import { render } from 'preact';
import { OptionsApp } from '@/ui/OptionsApp';

const root = document.getElementById('app');
if (root) render(<OptionsApp />, root);

export type ThemeColors = {
  background: string; surface: string; surfaceSecondary: string; surfaceElevated: string;
  textPrimary: string; textSecondary: string; textMuted: string; border: string;
  primary: string; primaryPressed: string; primarySoft: string; onPrimary: string;
  success: string; successSoft: string; warning: string; warningSoft: string;
  danger: string; dangerSoft: string; disabled: string; overlay: string;
  navBackground: string; skeleton: string;
};

export const lightColors: ThemeColors = {
  background: '#EFF3F8', surface: '#FFFFFF', surfaceSecondary: '#F6F8FB', surfaceElevated: '#FFFFFF',
  textPrimary: '#151B2B', textSecondary: '#4D586B', textMuted: '#626D80', border: '#DCE4EE',
  primary: '#A72A60', primaryPressed: '#84204C', primarySoft: '#F8E3ED', onPrimary: '#FFFFFF',
  success: '#08796D', successSoft: '#DDF7F2', warning: '#8A5D00', warningSoft: '#FFF2CF',
  danger: '#B42348', dangerSoft: '#FCE8ED', disabled: '#9AA4B3', overlay: 'rgba(10,15,28,0.52)',
  navBackground: 'rgba(255,255,255,0.96)', skeleton: '#E4EAF1',
};

export const darkColors: ThemeColors = {
  background: '#0F1420', surface: '#181F2D', surfaceSecondary: '#202838', surfaceElevated: '#252E40',
  textPrimary: '#F7F9FC', textSecondary: '#C5CCDA', textMuted: '#A7B0C1', border: '#303A4D',
  primary: '#E05B91', primaryPressed: '#C64378', primarySoft: '#351B2C', onPrimary: '#0F1420',
  success: '#5ED7C8', successSoft: '#153B38', warning: '#E3C260', warningSoft: '#3D351C',
  danger: '#FF7B9B', dangerSoft: '#41212C', disabled: '#687386', overlay: 'rgba(0,0,0,0.66)',
  navBackground: 'rgba(24,31,45,0.97)', skeleton: '#293345',
};

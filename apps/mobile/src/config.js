import { Platform } from 'react-native';

const apiHost = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';

export const API_URL = `http://${apiHost}:4000/api/v1`;

import { Spin } from '@arco-design/web-react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';

type AppLoaderProps = {
  overlay?: boolean;
};

const AppLoader: React.FC<AppLoaderProps> = ({ overlay = false }) => {
  const { t } = useTranslation();

  return (
    <div
      className={classNames('route-loader', overlay ? 'route-loader--overlay' : 'route-loader--page')}
      role='status'
      aria-busy='true'
      aria-label={t('common.loading')}
    >
      {overlay && (
        <div className='route-loader__progress' aria-hidden='true'>
          <span />
        </div>
      )}
      <div className='route-loader__indicator'>
        <Spin dot />
      </div>
    </div>
  );
};

export default AppLoader;

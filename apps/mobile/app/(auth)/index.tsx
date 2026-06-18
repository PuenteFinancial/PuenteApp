import { View, Text } from 'react-native'
import { useTranslation } from 'react-i18next'

export default function Welcome() {
  const { t } = useTranslation()
  return (
    <View className="flex-1 items-center justify-center bg-white px-6">
      <Text className="text-3xl font-bold text-gray-900">{t('welcome.title')}</Text>
      <Text className="mt-2 text-center text-gray-500">{t('welcome.tagline')}</Text>
    </View>
  )
}
